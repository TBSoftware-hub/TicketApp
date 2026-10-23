import {
  afterScan,
  decideOffline,
  describeScan,
  doorListSchema,
  doorScanResultSchema,
  OFFLINE_NOT_ON_LIST,
  searchDoorList,
  type DoorList,
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
  /** When it was made, in ISO form. */
  offlineAt: string;
  /** What the door told staff, so a different answer from TicketApp can be pointed out. */
  outcome: DoorScanResult["outcome"];
  shown: string;
  name: string;
}

/** A scan sent after the connection came back that TicketApp answered differently, or refused. */
export interface SyncProblem {
  key: string;
  eventId: string;
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
  /** When the saved list for this event was downloaded, if there is one. */
  listSavedAt: Date | null;
  /** Scans for this event made offline and not sent yet. */
  pending: number;
  /** Scans for this event that TicketApp answered differently once they were sent. */
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
  const saved = useRef<Saved>({ scans: [], problems: [] });
  const loaded = useRef<Promise<void> | null>(null);
  // Counts changes made to the saved list here, so a download started before one is thrown away.
  const changes = useRef(0);
  const syncing = useRef(false);
  const eventRef = useRef(event);
  eventRef.current = event;
  const callRef = useRef(call);
  callRef.current = call;

  const setReachable = useCallback((value: boolean) => {
    reachableRef.current = value;
    setReachableState(value);
  }, []);

  const load = useCallback(() => {
    loaded.current ??= Promise.all([readFile(DOOR_LIST_FILE), readFile(DOOR_QUEUE_FILE)])
      .then(([rawList, rawSaved]) => {
        list.current = parseList(rawList);
        saved.current = parseSaved(rawSaved);
      })
      .catch(() => undefined)
      .finally(rerender);
    return loaded.current;
  }, [rerender]);

  const saveList = useCallback(() => {
    void writeFile(DOOR_LIST_FILE, list.current && JSON.stringify(list.current)).catch(
      () => undefined,
    );
  }, []);
  const saveQueue = useCallback(() => {
    void writeFile(DOOR_QUEUE_FILE, JSON.stringify(saved.current)).catch(() => undefined);
  }, []);

  const isOffline = useCallback(
    () => !reachableRef.current || pendingFor(saved.current, eventRef.current?.id) > 0,
    [],
  );

  /** The saved ticket a scan is for, if this event's list has it. */
  const find = useCallback(async (scan: DoorScanRequest) => {
    const hash = scan.code === undefined ? undefined : await hashCode(scan.code);
    const current = list.current;
    if (!current || current.eventId !== eventRef.current?.id) return null;
    const index = current.tickets.findIndex((t) =>
      hash === undefined ? t.ticketId === scan.ticketId : t.codeHash === hash,
    );
    return { current, index };
  }, []);

  const sync = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      await load();
      while (saved.current.scans.length > 0) {
        const scan = saved.current.scans[0]!;
        const { orgId, eventId, key, offlineAt, outcome, shown, name } = scan;
        let answer: string | null = null;
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
          else if (parsed.data.outcome !== outcome) answer = describeScan(parsed.data, "UTC").title;
        } catch (err) {
          if (!(err instanceof ApiError) || err.status === 0) {
            setReachable(false);
            return;
          }
          setReachable(true);
          // Signed out, busy or broken: the scan waits for the next try.
          if (err.status === 401 || err.status === 429 || err.status >= 500) return;
          // Turned down for good, such as an event cancelled since: staff need to know.
          answer = err.message;
        }
        saved.current = {
          scans: saved.current.scans.filter((s) => s.key !== key),
          problems:
            answer === null
              ? saved.current.problems
              : [...saved.current.problems, { key, eventId, name, offlineAt, shown, answer }],
        };
        saveQueue();
        rerender();
      }

      // Download the list again once it's stale, or to find out if TicketApp is back. Not while
      // scans for the event wait to be sent: the list wouldn't have them yet.
      const current = eventRef.current;
      if (!current || pendingFor(saved.current, current.id) > 0) return;
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
        if (changes.current !== before || eventRef.current?.id !== current.id) return;
        list.current = { ...doorListSchema.parse(res), eventId: current.id, savedAt: Date.now() };
        saveList();
        rerender();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status === 0) setReachable(false);
      }
    } finally {
      syncing.current = false;
    }
  }, [load, saveList, saveQueue, setReachable, rerender]);

  const eventId = event?.id;
  useEffect(() => {
    if (!eventId) return;
    void sync();
    const timer = setInterval(() => void sync(), SYNC_EVERY_MS);
    return () => clearInterval(timer);
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
      const fromList = `Answered offline from the list saved at ${time(new Date(found.current.savedAt))}.`;
      const ticket = found.current.tickets[found.index];
      if (!ticket) {
        return { ...OFFLINE_NOT_ON_LIST, lines: [...OFFLINE_NOT_ON_LIST.lines, fromList] };
      }
      const { result, moves } = decideOffline(ticket, scan, found.current.reentryAllowed);
      const display = describeScan(result, current.organization.timezone);
      if (!moves) return { ...display, lines: [...display.lines, fromList] };

      const now = new Date();
      const tickets = [...found.current.tickets];
      tickets[found.index] = afterScan(ticket, result, now) ?? ticket;
      list.current = { ...found.current, tickets };
      changes.current++;
      saveList();
      saved.current = {
        ...saved.current,
        scans: [
          ...saved.current.scans,
          {
            ...scan,
            orgId: current.organization.id,
            eventId: current.id,
            offlineAt: now.toISOString(),
            outcome: result.outcome,
            shown: display.title,
            name: ticket.attendeeName,
          },
        ],
      };
      saveQueue();
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
    [find, load, saveList, saveQueue, rerender, sync],
  );

  const answered = useCallback(
    async (scan: DoorScanRequest, result: DoorScanResult) => {
      setReachable(true);
      const found = await find(scan);
      const ticket = found && found.current.tickets[found.index];
      if (!found || !ticket) return;
      const next = afterScan(ticket, result, new Date());
      const tickets = [...found.current.tickets];
      if (next) tickets[found.index] = next;
      else tickets.splice(found.index, 1);
      list.current = { ...found.current, tickets };
      changes.current++;
      saveList();
    },
    [find, saveList, setReachable],
  );

  const unreachable = useCallback(() => setReachable(false), [setReachable]);

  const search = useCallback((q: string) => {
    const current = list.current;
    if (!current || current.eventId !== eventRef.current?.id) return null;
    return searchDoorList(current.tickets, q);
  }, []);

  const dismissProblems = useCallback(() => {
    saved.current = {
      ...saved.current,
      problems: saved.current.problems.filter((p) => p.eventId !== eventRef.current?.id),
    };
    saveQueue();
    rerender();
  }, [saveQueue, rerender]);

  const pending = pendingFor(saved.current, eventId);
  const problems = saved.current.problems.filter((p) => p.eventId === eventId);
  const mine = list.current?.eventId === eventId ? list.current : null;

  // Rebuilt on each render, which follows every change to what's saved.
  const value = {
    offline: !reachable || pending > 0,
    reachable,
    isOffline,
    listSavedAt: mine ? new Date(mine.savedAt) : null,
    pending,
    problems,
    dismissProblems,
    answer,
    answered,
    unreachable,
    search,
  };
  return <Context value={value}>{children}</Context>;
}
