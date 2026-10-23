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
