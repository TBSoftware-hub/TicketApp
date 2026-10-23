import {
  afterScan,
  decideOffline,
  describeScan,
  doorListChangesSchema,
  doorListSchema,
  doorScanResultSchema,
  OFFLINE_EVENT_ENDED,
  OFFLINE_NOT_ON_LIST,
  OFFLINE_NOT_SAVED,
  OFFLINE_SCAN_MAX_AGE_MS,
  searchDoorList,
  withChanges,
  withMovements,
  type DoorList,
  type DoorListTicket,
  type DoorLookupResult,
  type DoorScanResult,
  type ScanDirection,
  type ScanDisplay,
  type ScanOverride,
} from "@ticketapp/shared";
import * as Crypto from "expo-crypto";
import { createContext, use, useCallback, useEffect, useRef, useState } from "react";
import type { PropsWithChildren } from "react";
import { ApiError } from "./api";
import { DOOR_LIST_FILE, DOOR_QUEUE_FILE, readFile, writeFile } from "./door-store";
import { useSession } from "./session";

/** How often the door sends scans saved offline, or tries TicketApp again after losing it. */
const SYNC_EVERY_MS = 15_000;
/**
 * How often the saved list asks TicketApp what the other doors did, while it can be reached: the
 * list is what the door answers from if the connection drops, so it's kept seconds old.
 */
const CHANGES_EVERY_MS = 3_000;
/**
 * How old the downloaded list may get, while TicketApp can be reached, before it's downloaded
 * again: the changes cover scans and waivers, and a download picks up everything else, such as
 * tickets bought since.
 */
const LIST_FRESH_MS = 60_000;
/** How long sending one saved scan may take before the door waits for the next try. */
const SEND_TIMEOUT_MS = 10_000;
/** The list can be a few thousand people, so it gets longer to arrive. */
const LIST_TIMEOUT_MS = 30_000;

/**
 * A scan as the door sends it: the code, or the ticket staff picked after looking someone up by
 * name, which way it takes them, the key a retry of the same scan sends again, and, when staff let
 * them in past an answer, which answer and why.
 */
export interface DoorScanRequest {
  code?: string;
  ticketId?: string;
  direction: ScanDirection;
  key: string;
  override?: ScanOverride;
  overrideReason?: string;
  /** When staff scanned it, in ms; kept through retries so a late answer keeps the real time. */
  at?: number;
}

/**
 * The event's list as this device saved it, and when that was. `fetchedAt` is when TicketApp put
 * together what it was last brought up to date with, and is what the next changes are asked from.
 */
interface SavedList extends DoorList {
  eventId: string;
  /** When it was last brought up to date, by a download or with the changes since one. */
  savedAt: number;
  /** When it was last downloaded whole. */
  downloadedAt: number;
  /** TicketApp gave an answer the list can't be brought up to date from: download it again. */
  stale?: boolean;
}

/** A scan made offline that let someone in or out, waiting to be sent. */
interface QueuedScan extends DoorScanRequest {
  /** Who made it; only they are shown what TicketApp made of it. */
  staffId: string;
  orgId: string;
  eventId: string;
  eventName: string;
  timeZone: string;
  /** The ticket it moved, however staff found it: by QR code or by name. */
  listTicketId: string;
  /** When it was made, in ISO form. */
  offlineAt: string;
  /** What the door told staff, so a different answer from TicketApp can be pointed out. */
  outcome: "admitted" | "checked_out";
  shown: string;
  name: string;
}

/** A scan sent after the connection came back that TicketApp answered differently, or refused. */
export interface SyncProblem {
  key: string;
  staffId: string;
  eventId: string;
  eventName: string;
  timeZone: string;
  name: string;
  offlineAt: string;
  /** What the door said at the time, such as "Let them in". */
  shown: string;
  /** What TicketApp said once it got the scan. */
  answer: string;
}

interface Saved {
  scans: QueuedScan[];
  problems: SyncProblem[];
}

interface OfflineContext {
  /** Scans are answered from the saved list: TicketApp can't be reached, or scans wait to be sent. */
  offline: boolean;
  /** The last call to TicketApp got through. */
  reachable: boolean;
  /** The same, read when called: the camera can hold on to a scan handler from an earlier render. */
  isOffline: () => boolean;
  /** Scans for this event saved offline are still to be sent, read when called. */
  hasPending: () => boolean;
  /** When the saved list for this event was downloaded, if there is one. */
  listSavedAt: Date | null;
  /** Scans for this event made offline and not sent yet. */
  pending: number;
  /**
   * How many are inside by the saved list, which keeps up with every door while TicketApp can be
   * reached; null with no list for this event.
   */
  inside: number | null;
  /**
   * Of those, the ones someone else made, which wait for them to sign back in on this device:
   * TicketApp records each scan as whoever sends it.
   */
  waitingForOthers: number;
  /**
   * Waits for the scans saved on this device to be read back after the app starts. False if they
   * can't be read: a scan sent now could reach TicketApp ahead of one made earlier.
   */
  ready: () => Promise<boolean>;
  /** The saved ticket a scan is for as it is now, to answer from if the scan's answer is lost. */
  before: (scan: DoorScanRequest) => Promise<DoorListTicket | null>;
  /**
   * Scans the signed-in staff member made that TicketApp answered differently once they were
   * sent, for any event: the event may have ended since, and they still need to see them.
   */
  problems: SyncProblem[];
  dismissProblems: () => void;
  /**
   * Answers a scan from the saved list, or null with no list to answer from. `before` is the
   * ticket as it was when the scan was sent to TicketApp and lost: a list downloaded meanwhile may
   * already show what that scan did, which mustn't then turn staff away. Null when it wasn't on
   * the list then, so nothing here can say what that scan did: it's left for staff to try again,
   * which sends it with the same key.
   */
  answer: (scan: DoorScanRequest, before?: DoorListTicket | null) => Promise<ScanDisplay | null>;
  /** Keeps the saved list in step with an answer TicketApp gave. */
  answered: (scan: DoorScanRequest, result: DoorScanResult) => Promise<void>;
  /** TicketApp turned down a scan for an event this account can't work, or that can't be worked. */
  refused: (eventId: string) => void;
  /** A call just failed to reach TicketApp. */
  unreachable: () => void;
  /** Finds people on the saved list by name, or null with no list to look in. */
  search: (q: string) => DoorLookupResult | null;
}

const Context = createContext<OfflineContext | null>(null);

export function useOffline(): OfflineContext {
  const value = use(Context);
  if (!value) throw new Error("useOffline must be used inside <OfflineProvider>");
  return value;
}

function pendingFor({ scans }: Saved, eventId: string | undefined) {
  return scans.filter((s) => s.eventId === eventId).length;
}

function hashCode(code: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, code);
}

function parseList(raw: string | null): SavedList | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SavedList;
    return {
      ...doorListSchema.parse(value),
      eventId: String(value.eventId),
      savedAt: Number(value.savedAt),
      // Saved before changes were asked for, when the two were the same.
      downloadedAt: Number(value.downloadedAt ?? value.savedAt),
    };
  } catch {
    // Saved by an older version of the app, or corrupted: download it again.
    return null;
  }
}

/**
 * The queue as saved, empty when there's no file yet. A file that can't be read as one throws:
 * it's left as it is, and scanning waits, rather than scans after it overtaking the ones in it.
 */
function parseSaved(raw: string | null): Saved {
  if (raw === null) return { scans: [], problems: [] };
  const value = JSON.parse(raw) as Partial<Saved> | null;
  if (!value || !Array.isArray(value.scans) || !Array.isArray(value.problems)) {
    throw new Error("The saved scans can't be read");
  }
  return { scans: value.scans, problems: value.problems };
}

/**
 * The scans waiting to be sent and the problems to show, kept once for the whole app as the file
 * keeps them: a door screen left behind by signing out and back in can't then save an older copy
 * over a newer one, or send the same scan alongside the new screen.
 */
const queue = {
  saved: { scans: [], problems: [] } as Saved,
  loaded: null as Promise<boolean> | null,
  /** The file has been read: until then nothing is written over it, or sent ahead of it. */
  restored: false,
  syncing: false,
};

/** Reads the queue back once; a read that fails is tried again on the next call. */
function loadQueue(): Promise<boolean> {
  queue.loaded ??= readFile(DOOR_QUEUE_FILE)
    .then((raw) => {
      queue.saved = parseSaved(raw);
      queue.restored = true;
      return true;
    })
    .catch(() => {
      queue.loaded = null;
      return false;
    });
  return queue.loaded;
}

let queueWrites: Promise<void> = Promise.resolve();

/**
 * Changes the queue and saves it, one change at a time, each made to what the last one left. The
 * change only counts once it's written, so a scan is never reported saved that a restart would lose.
 */
function changeQueue(change: (saved: Saved) => Saved): Promise<void> {
  const run = async () => {
    if (!queue.restored) throw new Error("The saved scans haven't been read yet");
    const next = change(queue.saved);
    await writeFile(DOOR_QUEUE_FILE, JSON.stringify(next));
    queue.saved = next;
  };
  const done = queueWrites.then(run, run);
  queueWrites = done.catch(() => undefined);
  return done;
}

/** The list with one ticket changed: `next` gives it after, or null to take it off. */
function changeTicket(
  list: SavedList,
  ticketId: string,
  next: (ticket: DoorListTicket) => DoorListTicket | null,
): SavedList {
  const index = list.tickets.findIndex((t) => t.ticketId === ticketId);
  if (index < 0) return list;
  const tickets = [...list.tickets];
  const after = next(tickets[index]!);
  if (after) tickets[index] = after;
  else tickets.splice(index, 1);
  return { ...list, tickets };
}

/** A saved list with the moves still waiting to be sent for its event applied. */
function withQueued(list: SavedList): SavedList {
  const movements = queue.saved.scans
    .filter((s) => s.eventId === list.eventId)
    .map((s) => ({ ticketId: s.listTicketId, outcome: s.outcome, at: new Date(s.offlineAt) }));
  return { ...list, tickets: withMovements(list.tickets, movements) };
}

/**
 * Keeps the door working when the connection drops: a saved copy of the event's list to answer
 * scans from, and the scans that let people in or out while offline, sent in order once
 * TicketApp can be reached again.
 */
export function OfflineProvider({ children }: PropsWithChildren) {
  const { event, call, session } = useSession();
  const staffId = session?.staff.id;
  const staffIdRef = useRef(staffId);
  staffIdRef.current = staffId;
  const [, setRevision] = useState(0);
  const rerender = useCallback(() => setRevision((r) => r + 1), []);
  const [reachable, setReachableState] = useState(true);
  // The source of truth is kept in refs, so answers given in quick succession each see the last.
  const reachableRef = useRef(true);
  const list = useRef<SavedList | null>(null);
  const loaded = useRef<Promise<boolean> | null>(null);
  // Counts lists dropped here, so a download started before one is thrown away.
  const drops = useRef(0);
  // Events TicketApp has refused here, so a list still being read back from the device for one
  // isn't brought back.
  const refusedEvents = useRef(new Set<string>());
  // While the list or its changes are on their way, the changes made here, to make again to them.
  const edits = useRef<{ eventId: string; change: (l: SavedList) => SavedList }[] | null>(null);
  // False once signed out: a download that lands after that mustn't save everyone's names again.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const eventRef = useRef(event);
  eventRef.current = event;
  const callRef = useRef(call);
  callRef.current = call;

  const setReachable = useCallback((value: boolean) => {
    reachableRef.current = value;
    setReachableState(value);
  }, []);

  /** Reads back what's saved, once; true once the queue has been. */
  const load = useCallback(() => {
    loaded.current ??= Promise.all([readFile(DOOR_LIST_FILE).catch(() => null), loadQueue()])
      .then(([rawList, restored]) => {
        if (!restored) {
          // Tried again next time: until then nothing is sent, saved or answered online.
          loaded.current = null;
          return false;
        }
        const saved = parseList(rawList);
        if (saved && refusedEvents.current.has(saved.eventId)) {
          void writeFile(DOOR_LIST_FILE, null).catch(() => undefined);
          list.current = null;
        } else {
          list.current = saved && withQueued(saved);
        }
        return true;
      })
      .finally(rerender);
    return loaded.current;
  }, [rerender]);

  const saveList = useCallback(() => {
    if (!mounted.current) return;
    void writeFile(DOOR_LIST_FILE, list.current && JSON.stringify(list.current)).catch(
      () => undefined,
    );
  }, []);

  /**
   * Stops answering from an event's saved list once TicketApp has said it won't let this account
   * work the event, or the event can't be worked any more.
   */
  const dropList = useCallback(
    (eventId: string) => {
      // A screen left behind by signing out mustn't touch the list the next one saved.
      if (!mounted.current) return;
      // A download on its way, even the first, mustn't bring the list back; nor one being read
      // back from the device.
      drops.current++;
      refusedEvents.current.add(eventId);
      if (list.current?.eventId !== eventId) return;
      list.current = null;
      void writeFile(DOOR_LIST_FILE, null).catch(() => undefined);
      rerender();
    },
    [rerender],
  );

  const isOffline = useCallback(
    () => !reachableRef.current || pendingFor(queue.saved, eventRef.current?.id) > 0,
    [],
  );
  const hasPending = useCallback(() => pendingFor(queue.saved, eventRef.current?.id) > 0, []);

  /** The saved ticket a scan is for, if this event's list has it. */
  const find = useCallback(async (scan: Pick<DoorScanRequest, "code" | "ticketId">) => {
    const hash = scan.code === undefined ? undefined : await hashCode(scan.code);
    const current = list.current;
    if (!current || current.eventId !== eventRef.current?.id) return null;
    const index = current.tickets.findIndex((t) =>
      hash === undefined ? t.ticketId === scan.ticketId : t.codeHash === hash,
    );
    return { current, index };
  }, []);

  /**
   * Changes an event's saved list as it is now, which may have changed since the caller last
   * looked; and the list being downloaded too, once it lands.
   */
  const updateList = useCallback(
    (eventId: string, change: (l: SavedList) => SavedList) => {
      edits.current?.push({ eventId, change });
      const current = list.current;
      if (current?.eventId !== eventId) return;
      list.current = change(current);
      saveList();
    },
    [saveList],
  );

  /** Updates one ticket on the saved list: `next` gives it after, or null to take it off. */
  const updateTicket = useCallback(
    (eventId: string, ticketId: string, next: (ticket: DoorListTicket) => DoorListTicket | null) =>
      updateList(eventId, (l) => changeTicket(l, ticketId, next)),
    [updateList],
  );

  /**
   * Takes the event's re-entry rule from an answer that gives it, so the saved list keeps up
   * with re-entry turned off, or on, since it was downloaded.
   */
  const learnPolicy = useCallback(
    (eventId: string, result: DoorScanResult) => {
      const reentryAllowed =
        result.outcome === "checked_out"
          ? result.reentryAllowed
          : result.outcome === "reentry_denied"
            ? false
            : null;
      if (reentryAllowed === null) return;
      updateList(eventId, (l) =>
        l.reentryAllowed === reentryAllowed ? l : { ...l, reentryAllowed },
      );
    },
    [updateList],
  );

  const sync = useCallback(async () => {
    if (queue.syncing) return;
    queue.syncing = true;
    try {
      if (!(await load())) return;
      // Events whose scans this account can't send; later scans for them wait too, to stay in order.
      const held = new Set<string>();
      for (const scan of [...queue.saved.scans]) {
        const { orgId, eventId, eventName, timeZone, key, offlineAt, outcome, shown, name } = scan;
        const madeBy = scan.staffId;
        if (held.has(eventId)) continue;
        let answer: string | null = null;
        if (Date.parse(offlineAt) < Date.now() - OFFLINE_SCAN_MAX_AGE_MS) {
          answer = "Not sent within a day of being made, so TicketApp can't take it";
        } else if (madeBy !== staffIdRef.current) {
          // TicketApp records a scan as whoever sends it, so someone else's waits for them to sign
          // back in here, and the scans after it for the same event wait behind it.
          held.add(eventId);
          continue;
        } else {
          try {
            const res = await callRef.current(`/orgs/${orgId}/events/${eventId}/scans`, {
              method: "POST",
              body: {
                scanKey: key,
                offlineAt,
                code: scan.code,
                ticketId: scan.ticketId,
                direction: scan.direction,
                override: scan.override,
                overrideReason: scan.overrideReason,
              },
              timeoutMs: SEND_TIMEOUT_MS,
            });
            setReachable(true);
            const parsed = doorScanResultSchema.safeParse(res);
            if (!parsed.success) answer = "TicketApp gave an answer this app doesn't understand";
            else {
              const result = parsed.data;
              if (result.outcome !== outcome) answer = describeScan(result, timeZone).title;
              // The event's re-entry rule is the same whatever comes after.
              learnPolicy(eventId, result);
              // The list takes TicketApp's word for it, unless a later saved scan of the same
              // ticket, by code or by name, is still to go, whose answer will be the newer one.
              const later = queue.saved.scans.some(
                (s) =>
                  s.key !== key && s.eventId === eventId && s.listTicketId === scan.listTicketId,
              );
              if (result.outcome === outcome || result.outcome === "invalid_ticket") {
                if (!later) {
                  updateTicket(eventId, scan.listTicketId, (t) =>
                    afterScan(t, result, new Date(offlineAt)),
                  );
                }
              } else {
                // A different answer may be one TicketApp gave this scan earlier, whose answer was
                // lost, and say nothing of where they stand now. Until the list is downloaded
                // again, which happens next, their ticket isn't answered for offline.
                updateList(eventId, (l) => ({
                  ...changeTicket(l, scan.listTicketId, () => null),
                  stale: true,
                }));
              }
            }
          } catch (err) {
            if (!(err instanceof ApiError) || err.status === 0) {
              setReachable(false);
              return;
            }
            setReachable(true);
            // Signed out, busy or broken: the scan waits for the next try.
            if (err.status === 401 || err.status === 429 || err.status >= 500) return;
            // Whoever is signed in now can't work this event: keep its scans for someone who can,
            // but stop answering from its list.
            if (err.status === 403 || err.status === 404) {
              held.add(eventId);
              dropList(eventId);
              continue;
            }
            // Turned down for good, such as an event cancelled since: staff need to know. An event
            // that can't be worked any more can't be answered for from its list either.
            if (err.status === 409) dropList(eventId);
            answer = err.message;
          }
        }
        const problem =
          answer === null
            ? null
            : {
                key,
                staffId: madeBy,
                eventId,
                eventName,
                timeZone,
                name,
                offlineAt,
                shown,
                answer,
              };
        try {
          await changeQueue((saved) => ({
            scans: saved.scans.filter((s) => s.key !== key),
            problems: problem ? [...saved.problems, problem] : saved.problems,
          }));
        } catch {
          // Couldn't save that it went: it's sent again next time, with the same key, so it
          // can't count twice.
          return;
        } finally {
          rerender();
        }
      }

      // Download the list again once it's stale, or to find out if TicketApp is back; otherwise
      // ask what the other doors did since. Not while scans for the event this account can send
      // are still to go: the list wouldn't have them yet. Ones waiting for someone else are put
      // back on it, as on a restart.
      const current = eventRef.current;
      if (!current || (pendingFor(queue.saved, current.id) > 0 && !held.has(current.id))) return;
      const mine = list.current?.eventId === current.id ? list.current : null;
      const fresh =
        mine &&
        !mine.stale &&
        reachableRef.current &&
        Date.now() - mine.downloadedAt < LIST_FRESH_MS
          ? mine
          : null;
      const base = `/orgs/${current.organization.id}/events/${current.id}/door-list`;
      const dropped = drops.current;
      const made: NonNullable<typeof edits.current> = [];
      edits.current = made;
      try {
        const res = await callRef.current(
          fresh
            ? `${base}/changes?since=${encodeURIComponent(fresh.fetchedAt.toISOString())}`
            : base,
          { timeoutMs: fresh ? SEND_TIMEOUT_MS : LIST_TIMEOUT_MS },
        );
        setReachable(true);
        if (!mounted.current || drops.current !== dropped || eventRef.current?.id !== current.id) {
          return;
        }
        let next: SavedList;
        if (fresh) {
          // Made to the list as it is now, which scans answered meanwhile have already changed.
          const now = list.current;
          if (now?.eventId !== current.id) return;
          const changes = doorListChangesSchema.parse(res);
          next = withQueued({
            ...now,
            reentryAllowed: changes.reentryAllowed,
            fetchedAt: changes.fetchedAt,
            tickets: withChanges(now.tickets, changes),
            savedAt: Date.now(),
          });
        } else {
          next = withQueued({
            ...doorListSchema.parse(res),
            eventId: current.id,
            savedAt: Date.now(),
            downloadedAt: Date.now(),
          });
        }
        // Scans answered while it was on its way are made again to it, in order: TicketApp may
        // have put it together before they reached it. A busy door is always answering one, so
        // throwing it away would keep the list from updating.
        for (const edit of made) {
          if (edit.eventId === current.id) next = edit.change(next);
        }
        // TicketApp let this account have the list, so it can be worked again.
        refusedEvents.current.delete(current.id);
        list.current = next;
        saveList();
        rerender();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status === 0) return setReachable(false);
        setReachable(true);
        // No access, no such event, or one cancelled or ended: its list can't be trusted.
        if (err.status === 403 || err.status === 404 || err.status === 409) dropList(current.id);
        // Too long since the list was brought up to date to ask what changed: download it.
        else if (fresh && err.status === 400) {
          updateList(current.id, (l) => ({ ...l, stale: true }));
        }
      } finally {
        if (edits.current === made) edits.current = null;
      }
    } finally {
      queue.syncing = false;
    }
  }, [load, updateList, updateTicket, learnPolicy, dropList, saveList, setReachable, rerender]);

  // Saved scans are sent whatever event is picked, or none: they may be for one that has ended.
  const eventId = event?.id;
  useEffect(() => {
    const timer = setInterval(() => void sync(), SYNC_EVERY_MS);
    // Keeps up with the other doors; tries to reach TicketApp again only at the slower pace.
    const changes = setInterval(() => {
      if (reachableRef.current) void sync();
    }, CHANGES_EVERY_MS);
    return () => {
      clearInterval(timer);
      clearInterval(changes);
    };
  }, [sync]);
  useEffect(() => {
    void sync();
  }, [eventId, sync]);

  const answer = useCallback(
    async (scan: DoorScanRequest, before?: DoorListTicket | null): Promise<ScanDisplay | null> => {
      if (!(await load())) return null;
      const current = eventRef.current;
      const found = current && (await find(scan));
      if (!current || !found || before === null) return null;
      const time = (d: Date) =>
        d.toLocaleTimeString("en-US", {
          timeZone: current.organization.timezone,
          hour: "numeric",
          minute: "2-digit",
        });
      const at = new Date(scan.at ?? Date.now());
      if (at >= current.endsAt) return OFFLINE_EVENT_ENDED;
      const fromList = `Answered offline from the list saved at ${time(new Date(found.current.savedAt))}.`;
      const now = found.current.tickets[found.index];
      // As it was before a lost scan of it, if that scan may since show on a downloaded list.
      const ticket = before && now?.ticketId === before.ticketId ? before : now;
      if (!ticket) {
        return { ...OFFLINE_NOT_ON_LIST, lines: [...OFFLINE_NOT_ON_LIST.lines, fromList] };
      }
      const { result, moves } = decideOffline(ticket, scan, found.current.reentryAllowed);
      const display = describeScan(result, current.organization.timezone);
      if (!moves || (result.outcome !== "admitted" && result.outcome !== "checked_out")) {
        return { ...display, lines: [...display.lines, fromList] };
      }

      if (!staffId) return null;
      const queued: QueuedScan = {
        ...scan,
        staffId,
        orgId: current.organization.id,
        eventId: current.id,
        eventName: current.name,
        timeZone: current.organization.timezone,
        listTicketId: ticket.ticketId,
        offlineAt: at.toISOString(),
        outcome: result.outcome,
        shown: display.title,
        name: ticket.attendeeName,
      };
      // Staff are only told to let them through once the scan is safely on the device.
      try {
        await changeQueue((saved) => ({ ...saved, scans: [...saved.scans, queued] }));
      } catch {
        return OFFLINE_NOT_SAVED;
      }
      // Applied to the list as it is now, which a send may have changed meanwhile.
      updateTicket(current.id, ticket.ticketId, (t) => afterScan(t, result, at) ?? t);
      rerender();
      // Back online but still sending earlier scans: this one goes straight after them.
      if (reachableRef.current) void sync();
      return {
        ...display,
        lines: [
          ...display.lines,
          "Saved on this device. It'll be sent when the connection is back.",
        ],
      };
    },
    [find, load, updateTicket, rerender, sync, staffId],
  );

  const ready = useCallback(() => load(), [load]);

  const before = useCallback(
    async (scan: DoorScanRequest) => {
      const found = await find(scan);
      return found?.current.tickets[found.index] ?? null;
    },
    [find],
  );

  const refused = useCallback((eventId: string) => dropList(eventId), [dropList]);

  const answered = useCallback(
    async (scan: DoorScanRequest, result: DoorScanResult) => {
      setReachable(true);
      const eventId = eventRef.current?.id;
      if (!eventId) return;
      const hash = scan.code === undefined ? undefined : await hashCode(scan.code);
      const at = new Date();
      learnPolicy(eventId, result);
      // Made to the list being downloaded too, which may have a ticket bought since the saved
      // one was, so it's found by its code or id there rather than here.
      updateList(eventId, (l) => {
        const ticket = l.tickets.find((t) =>
          hash === undefined ? t.ticketId === scan.ticketId : t.codeHash === hash,
        );
        return ticket ? changeTicket(l, ticket.ticketId, (t) => afterScan(t, result, at)) : l;
      });
    },
    [updateList, learnPolicy, setReachable],
  );

  const unreachable = useCallback(() => setReachable(false), [setReachable]);

  const search = useCallback((q: string) => {
    const current = list.current;
    if (!current || current.eventId !== eventRef.current?.id) return null;
    return searchDoorList(current.tickets, q);
  }, []);

  // Only whoever made a scan sees, or can dismiss, what TicketApp made of it: the device may be
  // handed to someone from another school.
  const dismissProblems = useCallback(() => {
    void changeQueue((saved) => ({
      ...saved,
      problems: saved.problems.filter((p) => p.staffId !== staffId),
    }))
      .catch(() => undefined)
      .finally(rerender);
  }, [rerender, staffId]);

  const pending = pendingFor(queue.saved, eventId);
  const waitingForOthers = queue.saved.scans.filter(
    (s) => s.eventId === eventId && s.staffId !== staffId,
  ).length;
  const mine = list.current?.eventId === eventId ? list.current : null;

  // Rebuilt on each render, which follows every change to what's saved.
  const value = {
    offline: !reachable || pending > 0,
    reachable,
    isOffline,
    hasPending,
    listSavedAt: mine ? new Date(mine.savedAt) : null,
    pending,
    inside: mine ? mine.tickets.filter((t) => t.checkIn === "inside").length : null,
    waitingForOthers,
    ready,
    before,
    problems: queue.saved.problems.filter((p) => p.staffId === staffId),
    dismissProblems,
    answer,
    answered,
    refused,
    unreachable,
    search,
  };
  return <Context value={value}>{children}</Context>;
}
