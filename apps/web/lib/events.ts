import type { EventStatus } from "@ticketapp/shared";

export interface EventRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  venue: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  status: EventStatus;
}

export const STATUS_LABELS: Record<EventStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "On sale",
  CANCELLED: "Cancelled",
};

export function formatEventTime(startsAt: string, endsAt: string, timeZone: string) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const sameDay = day.format(start) === day.format(end);
  return sameDay
    ? `${day.format(start)}, ${time.format(start)} – ${time.format(end)}`
    : `${day.format(start)}, ${time.format(start)} – ${day.format(end)}, ${time.format(end)}`;
}
