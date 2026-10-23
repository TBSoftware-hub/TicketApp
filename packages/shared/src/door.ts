import { z } from "zod";
import { attendeeCheckInFilterSchema, attendeeWaiverFilterSchema } from "./attendees";
import { scanDirectionSchema } from "./scan";

const timestamp = z.union([z.string(), z.date()]).pipe(z.coerce.date());

/** An event the signed-in staff member can run the door for, as the door app's event picker lists it. */
export const doorEventSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  venue: z.string().nullable(),
  startsAt: timestamp,
  endsAt: timestamp,
  organization: z.object({ id: z.uuid(), name: z.string(), timezone: z.string() }),
});
export type DoorEvent = z.infer<typeof doorEventSchema>;

export const doorEventsResponseSchema = z.object({ events: z.array(doorEventSchema) });

/** Doors usually open before the advertised start, so an event counts as on this long beforehand. */
export const DOORS_OPEN_EARLY_MS = 2 * 60 * 60 * 1000;

/** Whether the door app should show an event as on now or coming up later. */
export function doorEventTiming(
  event: Pick<DoorEvent, "startsAt" | "endsAt">,
  now: Date = new Date(),
): "now" | "later" {
  return event.startsAt.getTime() - DOORS_OPEN_EARLY_MS <= now.getTime() ? "now" : "later";
}

/** "Sat, May 2 · 7:00 PM – 1:00 AM" in the organization's time zone, for the event picker. */
export function formatDoorEventTime(
  event: Pick<DoorEvent, "startsAt" | "endsAt" | "organization">,
) {
  const { timezone: timeZone } = event.organization;
  const day = (d: Date) =>
    d.toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
  const time = (d: Date) =>
    d.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const start = day(event.startsAt);
  const end = day(event.endsAt);
  // An after-prom that runs past midnight still reads as one night; longer events show both days.
  const nextDay =
    end !== start && event.endsAt.getTime() - event.startsAt.getTime() < 24 * 60 * 60 * 1000;
  const endText = end === start || nextDay ? time(event.endsAt) : `${end}, ${time(event.endsAt)}`;
  return `${start} · ${time(event.startsAt)} – ${endText}`;
}

/** What staff can let someone in despite: a missing waiver, or leaving at a lock-in event. */
export const scanOverrideSchema = z.enum(["waiver_missing", "reentry_denied"]);
export type ScanOverride = z.infer<typeof scanOverrideSchema>;

/**
 * What the door app sends when it reads a ticket's QR code, or when staff pick someone found by
 * name: one or the other, never both.
 */
export const doorScanSchema = z
  .object({
    /** Made by the app once per scan and sent again on a retry, so a retry can't double-count. */
    scanKey: z.uuid(),
    // Apps from before check-out only ever scanned people in.
    direction: scanDirectionSchema.default("in"),
    // Scanners can pick up stray whitespace. Any QR code at all may be held up, such as a long
    // web address or contact card, and is answered as not a ticket, so the limit is generous.
    code: z
      .string()
      .trim()
      .min(1, "Scan a ticket's QR code")
      .max(4096, "That isn't a ticket code")
      .optional(),
    /** The ticket staff picked from a lookup by name, for someone without their QR code. */
    ticketId: z.uuid().optional(),
    /**
     * Sent when staff let someone in despite a blocking answer; kept on the scan's record. It only
     * lets them in past the answer named by `override`, so a reason given for a missing waiver
     * can't wave someone back in at a lock-in event.
     */
    overrideReason: z
      .string()
      .trim()
      .min(3, "Say why you're letting them in")
      .max(500, "Keep the reason under 500 characters")
      // Postgres text can't hold a zero byte, so a reason with one couldn't be kept on the record.
      .refine((reason) => !reason.includes("\u0000"), "Retype the reason")
      .optional(),
    // Apps from before re-entry rules only ever overrode a missing waiver.
    override: scanOverrideSchema.default("waiver_missing"),
  })
  .refine((scan) => (scan.code === undefined) !== (scan.ticketId === undefined), {
    message: "Scan a ticket's QR code",
    path: ["code"],
  });
export type DoorScan = z.infer<typeof doorScanSchema>;

/** Why a scanned code won't get anyone in. */
export const scanInvalidReasonSchema = z.enum([
  "unknown",
  "other_event",
  "cancelled",
  "transferred",
  "unpaid",
]);
export type ScanInvalidReason = z.infer<typeof scanInvalidReasonSchema>;

/** Why a valid ticket's holder can't come in until a waiver is signed or staff override it. */
export const scanWaiverMissingReasonSchema = z.enum(["not_signed", "guardian_pending"]);
export type ScanWaiverMissingReason = z.infer<typeof scanWaiverMissingReasonSchema>;

const scannedTicketSchema = z.object({ attendeeName: z.string(), ticketTypeName: z.string() });

/**
 * The answer to a door scan: admitted, already used, waiting on a waiver, kept out after leaving,
 * checked out, not inside to check out, or not a ticket that works here.
 */
export const doorScanResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("admitted"), ticket: scannedTicketSchema }),
  z.object({
    outcome: z.literal("already_inside"),
    ticket: scannedTicketSchema,
    /** When the ticket first got them in this time, if that scan is on record. */
    admittedAt: timestamp.nullable(),
  }),
  z.object({
    outcome: z.literal("waiver_missing"),
    ticket: scannedTicketSchema,
    reason: scanWaiverMissingReasonSchema,
  }),
  z.object({
    outcome: z.literal("reentry_denied"),
    ticket: scannedTicketSchema,
    /** When they checked out. */
    leftAt: timestamp,
  }),
  z.object({
    outcome: z.literal("checked_out"),
    ticket: scannedTicketSchema,
    /** Whether the event lets them back in, so staff can tell them before they go. */
    reentryAllowed: z.boolean(),
  }),
  z.object({
    outcome: z.literal("not_inside"),
    ticket: scannedTicketSchema,
    /** When they last checked out, or null when the ticket hasn't got them in yet. */
    leftAt: timestamp.nullable(),
  }),
  z.object({ outcome: z.literal("invalid_ticket"), reason: scanInvalidReasonSchema }),
]);
export type DoorScanResult = z.infer<typeof doorScanResultSchema>;

/** What door staff are told about a code that won't get anyone in. */
export const SCAN_INVALID_TEXT: Record<ScanInvalidReason, string> = {
  unknown: "This QR code isn't a TicketApp ticket.",
  other_event: "This ticket is for a different event.",
  cancelled: "This ticket was cancelled.",
  transferred: "This ticket was given to someone else, who has a new code.",
  unpaid: "This ticket hasn't been paid for.",
};

/** What door staff are told about a ticket held up by its waiver. */
export const SCAN_WAIVER_MISSING_TEXT: Record<ScanWaiverMissingReason, string> = {
  not_signed: "They haven't signed the event's waiver.",
  guardian_pending: "Their parent or guardian hasn't signed the waiver yet.",
};

/** Reasons door staff can pick for letting someone in without a signed waiver, or edit first. */
export const WAIVER_OVERRIDE_REASONS = [
  "Signed a paper waiver at the door",
  "Guardian is here and signed on paper",
  "Approved by the event chair",
];

/** Reasons door staff can pick for letting someone back in at an event without re-entry. */
export const REENTRY_OVERRIDE_REASONS = [
  "Stepped out with a chaperone",
  "Parent or guardian brought them back",
  "Approved by the event chair",
];

/** What door staff are asked, and can pick from, when they let someone in past each answer. */
export const SCAN_OVERRIDES: Record<
  ScanOverride,
  { question: (name: string) => string; reasons: string[] }
> = {
  waiver_missing: {
    question: (name) => `Let ${name} in without a waiver?`,
    reasons: WAIVER_OVERRIDE_REASONS,
  },
  reentry_denied: { question: (name) => `Let ${name} back in?`, reasons: REENTRY_OVERRIDE_REASONS },
};

/** How the door app shows a scan's answer: a colour staff can read at a glance, and the details. */
export interface ScanDisplay {
  tone: "go" | "stop" | "warn";
  title: string;
  lines: string[];
  /** Staff may let them in past this answer anyway, giving a reason. The first line is their name. */
  override?: ScanOverride;
}

export function describeScan(result: DoorScanResult, timeZone: string): ScanDisplay {
  const time = (d: Date) =>
    d.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  switch (result.outcome) {
    case "admitted":
      return {
        tone: "go",
        title: "Let them in",
        lines: [result.ticket.attendeeName, result.ticket.ticketTypeName],
      };
    case "already_inside": {
      const when = result.admittedAt && time(result.admittedAt);
      return {
        tone: "warn",
        title: "Already checked in",
        lines: [
          result.ticket.attendeeName,
          when ? `This ticket got someone in at ${when}.` : "This ticket has already been used.",
        ],
      };
    }
    case "waiver_missing":
      return {
        tone: "stop",
        title: "Waiver missing",
        lines: [result.ticket.attendeeName, SCAN_WAIVER_MISSING_TEXT[result.reason]],
        override: "waiver_missing",
      };
    case "reentry_denied":
      return {
        tone: "stop",
        title: "No re-entry",
        lines: [
          result.ticket.attendeeName,
          `They checked out at ${time(result.leftAt)}, and this event doesn't let people back in.`,
        ],
        override: "reentry_denied",
      };
    case "checked_out":
      return {
        tone: "go",
        title: "Checked out",
        lines: [
          result.ticket.attendeeName,
          result.reentryAllowed
            ? "They can come back in with the same ticket."
            : "They can't come back in tonight.",
        ],
      };
    case "not_inside":
      return {
        tone: "warn",
        title: "Not checked in",
        lines: [
          result.ticket.attendeeName,
          result.leftAt
            ? `They already checked out at ${time(result.leftAt)}.`
            : "This ticket hasn't been used to get in yet.",
        ],
      };
    case "invalid_ticket":
      return {
        tone: "stop",
        title: "Not a valid ticket",
        lines: [SCAN_INVALID_TEXT[result.reason]],
      };
  }
}

/** Door staff looking someone up by name, for a guest who can't show their QR code. */
export const doorLookupSchema = z.object({
  q: z
    .string()
    .trim()
    .min(2, "Type at least two letters of their name")
    .max(100, "Keep the search under 100 characters"),
});
export type DoorLookup = z.infer<typeof doorLookupSchema>;

/** Most people a lookup lists; more than that and staff are asked to type more of the name. */
export const DOOR_LOOKUP_LIMIT = 20;

/** Someone a lookup by name found: enough to tell two people with the same name apart. */
export const doorLookupTicketSchema = z.object({
  ticketId: z.uuid(),
  attendeeName: z.string(),
  ticketTypeName: z.string(),
  grade: z.number().int().nullable(),
  checkIn: attendeeCheckInFilterSchema,
  waiver: attendeeWaiverFilterSchema,
});
export type DoorLookupTicket = z.infer<typeof doorLookupTicketSchema>;

export const doorLookupResultSchema = z.object({
  tickets: z.array(doorLookupTicketSchema),
  /** More people matched than are listed. */
  more: z.boolean(),
});
export type DoorLookupResult = z.infer<typeof doorLookupResultSchema>;

/** The short status shown beside each name a lookup finds, and the colour it reads in. */
export function describeLookupTicket(ticket: DoorLookupTicket): {
  tone: ScanDisplay["tone"];
  status: string;
} {
  if (ticket.checkIn === "inside") return { tone: "warn", status: "Already inside" };
  if (ticket.checkIn === "left") return { tone: "warn", status: "Checked out" };
  if (ticket.waiver === "missing") return { tone: "stop", status: "Waiver missing" };
  if (ticket.waiver === "waiting") return { tone: "stop", status: "Waiting on guardian" };
  return { tone: "go", status: "Not arrived" };
}
