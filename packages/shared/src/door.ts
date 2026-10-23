import { z } from "zod";

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

/** What the door app sends when it reads a ticket's QR code. */
export const doorScanSchema = z.object({
  /** Made by the app once per scan and sent again on a retry, so a retry can't double-count. */
  scanKey: z.uuid(),
  // Scanners can pick up stray whitespace. Any QR code at all may be held up, such as a long
  // web address or contact card, and is answered as not a ticket, so the limit is generous.
  code: z.string().trim().min(1, "Scan a ticket's QR code").max(4096, "That isn't a ticket code"),
  /** Sent when staff let someone in whose waiver is missing; kept on the scan's record. */
  overrideReason: z
    .string()
    .trim()
    .min(3, "Say why you're letting them in")
    .max(500, "Keep the reason under 500 characters")
    // Postgres text can't hold a zero byte, so a reason with one couldn't be kept on the record.
    .refine((reason) => !reason.includes("\u0000"), "Retype the reason")
    .optional(),
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

/**
 * The answer to a door scan: admitted, already used, waiting on a waiver, or not a ticket that
 * works here.
 */
export const doorScanResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("admitted"),
    ticket: z.object({ attendeeName: z.string(), ticketTypeName: z.string() }),
  }),
  z.object({
    outcome: z.literal("already_inside"),
    ticket: z.object({ attendeeName: z.string(), ticketTypeName: z.string() }),
    /** When the ticket first got them in this time, if that scan is on record. */
    admittedAt: timestamp.nullable(),
  }),
  z.object({
    outcome: z.literal("waiver_missing"),
    ticket: z.object({ attendeeName: z.string(), ticketTypeName: z.string() }),
    reason: scanWaiverMissingReasonSchema,
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

/** How the door app shows a scan's answer: a colour staff can read at a glance, and the details. */
export interface ScanDisplay {
  tone: "go" | "stop" | "warn";
  title: string;
  lines: string[];
  /** Staff may let them in anyway, giving a reason. The first line is then their name. */
  overridable?: boolean;
}

export function describeScan(result: DoorScanResult, timeZone: string): ScanDisplay {
  switch (result.outcome) {
    case "admitted":
      return {
        tone: "go",
        title: "Let them in",
        lines: [result.ticket.attendeeName, result.ticket.ticketTypeName],
      };
    case "already_inside": {
      const when = result.admittedAt?.toLocaleTimeString("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      });
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
        overridable: true,
      };
    case "invalid_ticket":
      return {
        tone: "stop",
        title: "Not a valid ticket",
        lines: [SCAN_INVALID_TEXT[result.reason]],
      };
  }
}
