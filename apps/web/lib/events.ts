import type { EventStatus } from "@ticketapp/shared";

export { formatEventTime } from "@ticketapp/shared";

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
