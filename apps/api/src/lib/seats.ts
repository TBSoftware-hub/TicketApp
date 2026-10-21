import type { Prisma } from "@ticketapp/db";

/**
 * Tickets that take a seat: issued ones, plus ones held for a buyer who is still paying. A hold
 * past its expiry no longer counts, even before anything tidies it up.
 */
export const takesSeat = (now = new Date()): Prisma.TicketWhereInput => ({
  OR: [{ status: "VALID" }, { status: "HELD", order: { holdExpiresAt: { gt: now } } }],
});
