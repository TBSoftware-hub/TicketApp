import { gradeRangeLabel, type EventStatus, type SaleStatus } from "@ticketapp/shared";

export interface PublicTicketType {
  id: string;
  name: string;
  priceCents: number;
  maxPerOrder: number;
  salesStartAt: string | null;
  salesEndAt: string | null;
  studentsOnly: boolean;
  minGrade: number | null;
  maxGrade: number | null;
  requiresApproval: boolean;
  saleStatus: SaleStatus;
}

export interface PublicEvent {
  id: string;
  name: string;
  description: string | null;
  venue: string | null;
  startsAt: string;
  endsAt: string;
  status: EventStatus;
  organizationName: string;
  timezone: string;
}

/** Path of an event's public page, relative to the site. */
export function publicEventPath(orgSlug: string, eventSlug: string) {
  return `/e/${encodeURIComponent(orgSlug)}/${encodeURIComponent(eventSlug)}`;
}

/** Who a ticket is for, in a buyer's words, or null when anyone can buy it. */
export function whoCanBuy(tt: PublicTicketType): string | null {
  const parts: string[] = [];
  if (tt.studentsOnly) {
    parts.push(
      tt.minGrade === null && tt.maxGrade === null
        ? "Students only"
        : `Students in ${gradeRangeLabel(tt.minGrade, tt.maxGrade)}`,
    );
  }
  if (tt.requiresApproval) parts.push("Needs approval from the school");
  return parts.length ? parts.join(" · ") : null;
}

export function saleStatusLabel(tt: PublicTicketType, timeZone: string): string {
  switch (tt.saleStatus) {
    case "onSale":
      return tt.salesEndAt ? `On sale until ${formatShort(tt.salesEndAt, timeZone)}` : "On sale";
    case "upcoming":
      return `Goes on sale ${formatShort(tt.salesStartAt!, timeZone)}`;
    case "soldOut":
      return "Sold out";
    case "ended":
      return "Sales ended";
  }
}

function formatShort(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
