import {
  gradeRangeLabel,
  type EventStatus,
  type FeePayer,
  type SaleStatus,
  type WaiverField,
} from "@ticketapp/shared";
import { notFound } from "next/navigation";
import { cache } from "react";
import { api } from "./api";

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
  /** Waivers each attendee with this ticket signs at checkout. */
  waiverIds: string[];
  saleStatus: SaleStatus;
}

/** A waiver as a buyer reads and signs it. */
export interface PublicWaiver {
  id: string;
  version: number;
  title: string;
  body: string;
  fields: WaiverField[];
  requiresGuardianForMinors: boolean;
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
  /** Whether the organization can take card payments right now. */
  onlinePayments: boolean;
  cardFeePaidBy: FeePayer;
  serviceFeePaidBy: FeePayer;
  /** Whether a minor's guardian can be texted their signing link, not just emailed. */
  guardianTexts: boolean;
}

/** Path of an event's public page, relative to the site. */
export function publicEventPath(orgSlug: string, eventSlug: string) {
  return `/e/${encodeURIComponent(orgSlug)}/${encodeURIComponent(eventSlug)}`;
}

/** Whether a buyer can get this ticket type online right now. */
export function canBuyOnline(tt: PublicTicketType, event: PublicEvent) {
  return (
    event.status === "PUBLISHED" &&
    tt.saleStatus === "onSale" &&
    // Guest passes wait on staff approval, which online checkout doesn't do yet.
    !tt.requiresApproval &&
    (tt.priceCents === 0 || event.onlinePayments)
  );
}

/** The public event, for pages that share one request per render. 404s when it isn't public. */
export const loadPublicEvent = cache(async (orgSlug: string, eventSlug: string) => {
  const { status, data } = await api<{
    event: PublicEvent;
    ticketTypes: PublicTicketType[];
    waivers: PublicWaiver[];
  }>(`/public/events/${encodeURIComponent(orgSlug)}/${encodeURIComponent(eventSlug)}`);
  if (status === 404 || status === 400) notFound();
  if (!("event" in data)) throw new Error(`Couldn't load the event (${status})`);
  return data;
});

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
