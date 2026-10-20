import { formatCents } from "@ticketapp/shared";

export interface TicketTypeRecord {
  id: string;
  name: string;
  priceCents: number;
  quantity: number | null;
  maxPerOrder: number;
  salesStartAt: string | null;
  salesEndAt: string | null;
  /** Valid tickets only; voided ones don't count. */
  sold: number;
  /** Whether any ticket was ever issued, voided ones included. Such a type can't be deleted. */
  hasTickets: boolean;
}

export function formatPrice(cents: number) {
  return cents === 0 ? "Free" : formatCents(cents);
}

export function formatSaleWindow(start: string | null, end: string | null, timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (start && end) {
    return `On sale ${format.format(new Date(start))} – ${format.format(new Date(end))}`;
  }
  if (start) return `On sale from ${format.format(new Date(start))}`;
  if (end) return `On sale until ${format.format(new Date(end))}`;
  return "Sells whenever the event is on sale";
}

/** Dollars as someone would type them back into a price field: "15", "12.50". */
export function centsToDollarsInput(cents: number) {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}
