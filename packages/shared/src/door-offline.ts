import { z } from "zod";
import {
  DOOR_LOOKUP_LIMIT,
  doorLookupTicketSchema,
  scanInvalidReasonSchema,
  type DoorLookupResult,
  type DoorScanResult,
  type ScanDisplay,
  type ScanOverride,
} from "./door";
import type { ScanDirection } from "./scan";

const timestamp = z.union([z.string(), z.date()]).pipe(z.coerce.date());

/**
 * One ticket on the list a door device keeps for working offline. The QR code itself is never
 * sent: a lost phone mustn't hold every ticket for the event, so the device matches a scanned
 * code by its SHA-256 instead.
 */
export const doorListTicketSchema = doorLookupTicketSchema.extend({
  firstName: z.string(),
  lastName: z.string(),
  /** Lowercase hex SHA-256 of the ticket's QR code. */
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** When they last checked out, which keeps them out at an event without re-entry. */
  leftAt: timestamp.nullable(),
  /**
   * Why the ticket won't get anyone in, such as one voided or refunded while its holder is inside:
   * they're listed so they can still be checked out, but not let in again. Null for a valid ticket.
   */
  invalid: scanInvalidReasonSchema.nullable(),
});
export type DoorListTicket = z.infer<typeof doorListTicketSchema>;

/** Everyone who can get into an event, as a door device saves it for when the connection drops. */
export const doorListSchema = z.object({
  reentryAllowed: z.boolean(),
  tickets: z.array(doorListTicketSchema),
  /** When the API put the list together, so staff can tell how fresh an offline answer is. */
  fetchedAt: timestamp,
});
export type DoorList = z.infer<typeof doorListSchema>;

/**
 * What changed on an event's door list since a door device last asked: the tickets other doors
 * have scanned, or whose waiver was signed, as they stand now. `removed` are ones that were touched
 * and can't get anyone in any more. `fetchedAt` is what the device asks from next time.
 */
export const doorListChangesSchema = z.object({
  reentryAllowed: z.boolean(),
  tickets: z.array(doorListTicketSchema),
  removed: z.array(z.string()),
  fetchedAt: timestamp,
});
export type DoorListChanges = z.infer<typeof doorListChangesSchema>;

export const doorListChangesQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).pipe(z.coerce.date()),
});

/**
 * How far back a device may ask for changes: one that's been away longer downloads the whole list
 * again. And how far before `since` the API looks, for a scan whose transaction began before the
 * last answer was put together and was only saved after it.
 */
export const DOOR_CHANGES_MAX_AGE_MS = 10 * 60 * 1000;
export const DOOR_CHANGES_OVERLAP_MS = 30 * 1000;

/**
 * How far ahead of the API's clock a queued scan's time may be, for a device whose clock runs a
 * little fast; and how far back, so a forgotten phone can't post last week's scans.
 */
export const OFFLINE_SCAN_AHEAD_MS = 5 * 60 * 1000;
export const OFFLINE_SCAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Finds people on a saved list by name, the way the API's lookup does: every word must match. */
export function searchDoorList(tickets: DoorListTicket[], q: string): DoorLookupResult {
  const words = q.trim().toLowerCase().split(/\s+/);
  const found = tickets
    // A lookup only finds tickets that can get someone in.
    .filter((t) => !t.invalid)
    .filter((t) => {
      const first = t.firstName.toLowerCase();
      const last = t.lastName.toLowerCase();
      return words.every((w) => first.includes(w) || last.includes(w));
    })
    .sort(
      (a, b) =>
        a.lastName.localeCompare(b.lastName) ||
        a.firstName.localeCompare(b.firstName) ||
        a.ticketId.localeCompare(b.ticketId),
    );
  return {
    tickets: found
      .slice(0, DOOR_LOOKUP_LIMIT)
      .map(({ ticketId, attendeeName, ticketTypeName, grade, checkIn, waiver }) => ({
        ticketId,
        attendeeName,
        ticketTypeName,
        grade,
        checkIn,
        waiver,
      })),
    more: found.length > DOOR_LOOKUP_LIMIT,
  };
}

/**
 * The answer a door device gives from its saved list while it can't reach the API, by the same
 * rules the API applies. `moves` is true when it lets them in or out, which is the only kind of
 * scan the device keeps to send later: replaying a turned-away scan could let in someone the
 * device sent away, say once their waiver is signed.
 */
export function decideOffline(
  ticket: DoorListTicket,
  scan: { direction: ScanDirection; override?: ScanOverride; overrideReason?: string },
  reentryAllowed: boolean,
): { result: DoorScanResult; moves: boolean } {
  const details = { attendeeName: ticket.attendeeName, ticketTypeName: ticket.ticketTypeName };
  const isInside = ticket.checkIn === "inside";
  if (scan.direction === "out") {
    if (isInside) {
      return { result: { outcome: "checked_out", ticket: details, reentryAllowed }, moves: true };
    }
    if (ticket.invalid) {
      return { result: { outcome: "invalid_ticket", reason: ticket.invalid }, moves: false };
    }
    return {
      result: { outcome: "not_inside", ticket: details, leftAt: ticket.leftAt },
      moves: false,
    };
  }
  if (ticket.invalid) {
    return { result: { outcome: "invalid_ticket", reason: ticket.invalid }, moves: false };
  }
  if (isInside) {
    return {
      result: { outcome: "already_inside", ticket: details, admittedAt: null },
      moves: false,
    };
  }
  const overridden = (kind: ScanOverride) => !!scan.overrideReason && scan.override === kind;
  const { leftAt } = ticket;
  if (leftAt && !reentryAllowed && !overridden("reentry_denied")) {
    return { result: { outcome: "reentry_denied", ticket: details, leftAt }, moves: false };
  }
  // Someone coming back in isn't asked about their waiver again, as at the API.
  const missing = leftAt
    ? null
    : ticket.waiver === "missing"
      ? "not_signed"
      : ticket.waiver === "waiting"
        ? "guardian_pending"
        : null;
  if (missing && !overridden("waiver_missing")) {
    return {
      result: { outcome: "waiver_missing", ticket: details, reason: missing },
      moves: false,
    };
  }
  return { result: { outcome: "admitted", ticket: details }, moves: true };
}

/**
 * A saved ticket brought up to date with what a scan's answer says about it, so the next answer
 * given offline knows. Null when the ticket can't get anyone in any more, such as one cancelled
 * since the list was saved, which takes it off the list; unless its holder is inside, who stays on
 * it to be checked out.
 */
export function afterScan(
  ticket: DoorListTicket,
  result: DoorScanResult,
  at: Date,
): DoorListTicket | null {
  switch (result.outcome) {
    case "admitted":
    case "already_inside":
      return { ...ticket, checkIn: "inside" };
    case "checked_out":
      return { ...ticket, checkIn: "left", leftAt: at };
    case "reentry_denied":
      return { ...ticket, checkIn: "left", leftAt: result.leftAt };
    case "not_inside":
      return { ...ticket, checkIn: result.leftAt ? "left" : "not-arrived", leftAt: result.leftAt };
    case "waiver_missing":
      return {
        ...ticket,
        checkIn: "not-arrived",
        waiver: result.reason === "not_signed" ? "missing" : "waiting",
      };
    case "invalid_ticket":
      return ticket.checkIn === "inside" ? { ...ticket, invalid: result.reason } : null;
  }
}

/** What staff see for a code that isn't on the device's saved list. */
export const OFFLINE_NOT_ON_LIST: ScanDisplay = {
  tone: "stop",
  title: "Not on the saved list",
  lines: [
    "This device is offline and the code isn't on its list. It may not be a ticket, or it was bought after the list was saved.",
  ],
};

/** What staff see for a scan made offline after the event's end time. */
export const OFFLINE_EVENT_ENDED: ScanDisplay = {
  tone: "stop",
  title: "This event has ended",
  lines: ["Tickets can't be checked after the event's end time."],
};

/** What staff see when the device couldn't save a scan to send later, so it doesn't count. */
export const OFFLINE_NOT_SAVED: ScanDisplay = {
  tone: "stop",
  title: "Couldn't save this scan",
  lines: [
    "This device is offline and couldn't save the scan to send later, so it hasn't counted. Free up space on the phone, or try again once the connection is back.",
  ],
};

/** Someone the device let in or out while offline, in a scan not sent yet. */
export interface OfflineMovement {
  ticketId: string;
  outcome: "admitted" | "checked_out";
  at: Date;
}

/**
 * The saved tickets with the moves still waiting to be sent applied in order. The list and the
 * scans waiting to be sent are saved separately, so one restored after the app stopped part-way
 * through saving still knows who is inside. Applying a move twice changes nothing.
 */
export function withMovements(
  tickets: DoorListTicket[],
  movements: OfflineMovement[],
): DoorListTicket[] {
  const index = new Map(tickets.map((t, i) => [t.ticketId, i]));
  const next = [...tickets];
  for (const { ticketId, outcome, at } of movements) {
    const i = index.get(ticketId);
    if (i === undefined) continue;
    next[i] =
      outcome === "admitted"
        ? { ...next[i]!, checkIn: "inside" }
        : { ...next[i]!, checkIn: "left", leftAt: at };
  }
  return next;
}

/**
 * The saved tickets brought up to date with the changes TicketApp sent: each ticket sent takes
 * the place of the one saved, or joins the list, and each removed one comes off.
 */
export function withChanges(
  tickets: DoorListTicket[],
  changes: Pick<DoorListChanges, "tickets" | "removed">,
): DoorListTicket[] {
  const sent = new Map(changes.tickets.map((t) => [t.ticketId, t]));
  const removed = new Set(changes.removed);
  const next = tickets
    .filter((t) => !removed.has(t.ticketId))
    .map((t) => {
      const fresh = sent.get(t.ticketId);
      sent.delete(t.ticketId);
      return fresh ?? t;
    });
  return [...next, ...sent.values()];
}
