import { formatCents, gradeRangeLabel } from "@ticketapp/shared";

export interface TicketTypeRecord {
  id: string;
  name: string;
  priceCents: number;
  quantity: number | null;
  maxPerOrder: number;
  salesStartAt: string | null;
  salesEndAt: string | null;
  studentsOnly: boolean;
  minGrade: number | null;
  maxGrade: number | null;
  requiresApproval: boolean;
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

/** "Students in grades 11–12 · Needs approval", or "Anyone" for an open ticket. */
export function formatEligibility(tt: TicketTypeRecord) {
  const who = !tt.studentsOnly
    ? "Anyone"
    : tt.minGrade === null && tt.maxGrade === null
      ? "Students only"
      : `Students in ${gradeRangeLabel(tt.minGrade, tt.maxGrade)}`;
  return tt.requiresApproval ? `${who} · each purchase needs staff approval` : `${who} can buy`;
}
