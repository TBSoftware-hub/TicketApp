import {
  afterScan,
  decideOffline,
  describeScan,
  doorListSchema,
  doorScanResultSchema,
  OFFLINE_EVENT_ENDED,
  OFFLINE_NOT_ON_LIST,
  OFFLINE_NOT_SAVED,
  OFFLINE_SCAN_MAX_AGE_MS,
  searchDoorList,
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
/** How old the saved list may get, while TicketApp can be reached, before it's downloaded again. */
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

/** The event's list as this device saved it, and when that was. */
interface SavedList extends DoorList {
  eventId: string;
  savedAt: number;
}

/** A scan made offline that let someone in or out, waiting to be sent. */
interface QueuedScan extends DoorScanRequest {
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
   * Scans TicketApp answered differently once they were sent, for any event: the event may have
   * ended since, and staff still need to see them.
   */
  problems: SyncProblem[];
  dismissProblems: () => void;
  /** Answers a scan from the saved list, or null with no list to answer from. */
  answer: (scan: DoorScanRequest) => Promise<ScanDisplay | null>;
  /** Keeps the saved list in step with an answer TicketApp gave. */
  answered: (scan: DoorScanRequest, result: DoorScanResult) => Promise<void>;
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
    };
  } catch {
    // Saved by an older version of the app, or corrupted: download it again.
    return null;
  }
}

function parseSaved(raw: string | null): Saved {
  try {
    const value = raw ? (JSON.parse(raw) as Partial<Saved>) : {};
    return {
      scans: Array.isArray(value.scans) ? value.scans : [],
      problems: Array.isArray(value.problems) ? value.problems : [],
    };
  } catch {
    return { scans: [], problems: [] };
  }
}

/**
 * The scans waiting to be sent and the problems to show, kept once for the whole app as the file
 * keeps them: a door screen left behind by signing out and back in can't then save an older copy
 * over a newer one, or send the same scan alongside the new screen.
 */
const queue = {
  saved: { scans: [], problems: [] } as Saved,
  loaded: null as Promise<void> | null,
  syncing: false,
};

function loadQueue() {
  queue.loaded ??= readFile(DOOR_QUEUE_FILE)
    .then((raw) => {
      queue.saved = parseSaved(raw);
    })
    .catch(() => undefined);
  return queue.loaded;
}

function saveQueue() {
  void writeFile(DOOR_QUEUE_FILE, JSON.stringify(queue.saved)).catch(() => undefined);
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
  const { event, call } = useSession();
  const [, setRevision] = useState(0);
  const rerender = useCallback(() => setRevision((r) => r + 1), []);
  const [reachable, setReachableState] = useState(true);
  // The source of truth is kept in refs, so answers given in quick succession each see the last.
  const reachableRef = useRef(true);
  const list = useRef<SavedList | null>(null);
  const loaded = useRef<Promise<void> | null>(null);
  // Counts changes made to the saved list here, so a download started before one is thrown away.
  const changes = useRef(0);
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

  const load = useCallback(() => {
    loaded.current ??= Promise.all([readFile(DOOR_LIST_FILE), loadQueue()])
      .then(([rawList]) => {
        const saved = parseList(rawList);
        list.current = saved && withQueued(saved);
      })
      .catch(() => undefined)
      .finally(rerender);
    return loaded.current;
  }, [rerender]);

  const saveList = useCallback(() => {
    if (!mounted.current) return;
    void writeFile(DOOR_LIST_FILE, list.current && JSON.stringify(list.current)).catch(
      () => undefined,
    );
  }, []);

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
   * Updates one ticket on the saved list as it is now, which may have changed since the caller
   * last looked: `next` gives the ticket after, or null to take it off the list.
   */
  const updateTicket = useCallback(
    (
      eventId: string,
      ticketId: string,
      next: (ticket: DoorListTicket) => DoorListTicket | null,
    ) => {
      const current = list.current;
      const index =
        current?.eventId === eventId
          ? current.tickets.findIndex((t) => t.ticketId === ticketId)
          : -1;
      if (!current || index < 0) return;
      const tickets = [...current.tickets];
      const after = next(tickets[index]!);
      if (after) tickets[index] = after;
      else tickets.splice(index, 1);
      list.current = { ...current, tickets };
      changes.current++;
      saveList();
    },
    [saveList],
  );

  const sync = useCallback(async () => {
    if (queue.syncing) return;
    queue.syncing = true;
    try {
      await load();
      // Events whose scans this account can't send; later scans for them wait too, to stay in order.
      const held = new Set<string>();
      for (const scan of [...queue.saved.scans]) {
        const { orgId, eventId, eventName, timeZone, key, offlineAt, outcome, shown, name } = scan;
        if (held.has(eventId)) continue;
        let answer: string | null = null;
        if (Date.parse(offlineAt) < Date.now() - OFFLINE_SCAN_MAX_AGE_MS) {
          answer = "Not sent within a day of being made, so TicketApp can't take it";
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
              // The list takes TicketApp's word for it, unless a later saved scan of the same
              // ticket, by code or by name, is still to go, whose answer will be the newer one.
              const later = queue.saved.scans.some(
                (s) =>
                  s.key !== key && s.eventId === eventId && s.listTicketId === scan.listTicketId,
              );
              if (!later) {
                updateTicket(eventId, scan.listTicketId, (t) =>
                  afterScan(t, result, new Date(offlineAt)),
                );
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
            // Whoever is signed in now can't work this event: keep its scans for someone who can.
            if (err.status === 403 || err.status === 404) {
              held.add(eventId);
              continue;
            }
            // Turned down for good, such as an event cancelled since: staff need to know.
            answer = err.message;
          }
        }
        queue.saved = {
          scans: queue.saved.scans.filter((s) => s.key !== key),
          problems:
            answer === null
              ? queue.saved.problems
              : [
                  ...queue.saved.problems,
                  { key, eventId, eventName, timeZone, name, offlineAt, shown, answer },
                ],
        };
        saveQueue();
        rerender();
      }

      // Download the list again once it's stale, or to find out if TicketApp is back. Not while
      // scans for the event wait to be sent: the list wouldn't have them yet.
      const current = eventRef.current;
      if (!current || pendingFor(queue.saved, current.id) > 0) return;
      const mine = list.current?.eventId === current.id ? list.current : null;
      if (mine && reachableRef.current && Date.now() - mine.savedAt < LIST_FRESH_MS) return;
      const before = changes.current;
      try {
        const res = await callRef.current(
          `/orgs/${current.organization.id}/events/${current.id}/door-list`,
          { timeoutMs: LIST_TIMEOUT_MS },
        );
        setReachable(true);
        // A scan answered while it downloaded would be lost from it, so take the next one instead.
        if (!mounted.current || changes.current !== before || eventRef.current?.id !== current.id) {
          return;
        }
        list.current = { ...doorListSchema.parse(res), eventId: current.id, savedAt: Date.now() };
        saveList();
        rerender();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status === 0) setReachable(false);
      }
    } finally {
      queue.syncing = false;
    }
  }, [load, updateTicket, saveList, setReachable, rerender]);

  // Saved scans are sent whatever event is picked, or none: they may be for one that has ended.
  const eventId = event?.id;
  useEffect(() => {
    const timer = setInterval(() => void sync(), SYNC_EVERY_MS);
    return () => clearInterval(timer);
  }, [sync]);
  useEffect(() => {
    void sync();
  }, [eventId, sync]);

  const answer = useCallback(
    async (scan: DoorScanRequest): Promise<ScanDisplay | null> => {
      await load();
      const current = eventRef.current;
      const found = current && (await find(scan));
      if (!current || !found) return null;
      const time = (d: Date) =>
        d.toLocaleTimeString("en-US", {
          timeZone: current.organization.timezone,
          hour: "numeric",
          minute: "2-digit",
        });
      const at = new Date(scan.at ?? Date.now());
      if (at >= current.endsAt) return OFFLINE_EVENT_ENDED;
      const fromList = `Answered offline from the list saved at ${time(new Date(found.current.savedAt))}.`;
      const ticket = found.current.tickets[found.index];
      if (!ticket) {
        return { ...OFFLINE_NOT_ON_LIST, lines: [...OFFLINE_NOT_ON_LIST.lines, fromList] };
      }
      const { result, moves } = decideOffline(ticket, scan, found.current.reentryAllowed);
      const display = describeScan(result, current.organization.timezone);
      if (!moves || (result.outcome !== "admitted" && result.outcome !== "checked_out")) {
        return { ...display, lines: [...display.lines, fromList] };
      }

      const queued: QueuedScan = {
        ...scan,
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
        await writeFile(
          DOOR_QUEUE_FILE,
          JSON.stringify({ ...queue.saved, scans: [...queue.saved.scans, queued] }),
        );
      } catch {
        return OFFLINE_NOT_SAVED;
      }
      // Added to the queue and the list as they are now, which a send may have changed meanwhile.
      queue.saved = { ...queue.saved, scans: [...queue.saved.scans, queued] };
      saveQueue();
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
    [find, load, updateTicket, rerender, sync],
  );

  const answered = useCallback(
    async (scan: DoorScanRequest, result: DoorScanResult) => {
      setReachable(true);
      const found = await find(scan);
      const ticket = found?.current.tickets[found.index];
      if (!found || !ticket) return;
      updateTicket(found.current.eventId, ticket.ticketId, (t) => afterScan(t, result, new Date()));
    },
    [find, updateTicket, setReachable],
  );

  const unreachable = useCallback(() => setReachable(false), [setReachable]);

  const search = useCallback((q: string) => {
    const current = list.current;
    if (!current || current.eventId !== eventRef.current?.id) return null;
    return searchDoorList(current.tickets, q);
  }, []);

  const dismissProblems = useCallback(() => {
    queue.saved = { ...queue.saved, problems: [] };
    saveQueue();
    rerender();
  }, [rerender]);

  const pending = pendingFor(queue.saved, eventId);
  const mine = list.current?.eventId === eventId ? list.current : null;

  // Rebuilt on each render, which follows every change to what's saved.
  const value = {
    offline: !reachable || pending > 0,
    reachable,
    isOffline,
    hasPending,
    listSavedAt: mine ? new Date(mine.savedAt) : null,
    pending,
    problems: queue.saved.problems,
    dismissProblems,
    answer,
    answered,
    unreachable,
    search,
  };
  return <Context value={value}>{children}</Context>;
}
