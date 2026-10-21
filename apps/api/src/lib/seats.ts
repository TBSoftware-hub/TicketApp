import type { Prisma } from "@ticketapp/db";

/**
 * Tickets that take a seat: issued ones, plus ones held for a buyer who may be paying. A held
 * seat stays taken until Stripe confirms the order was never paid (see `settleLapsedHolds`), so a
 * buyer who paid and closed the tab before coming back can't lose their seat.
 */
export const takesSeat: Prisma.TicketWhereInput = { status: { in: ["VALID", "HELD"] } };

/**
 * What the public page shows as taken. Holds past their expiry are almost always abandoned, and
 * counting them would hide the Buy button until a checkout came along to settle them.
 */
export const shownAsTaken = (now = new Date()): Prisma.TicketWhereInput => ({
  OR: [{ status: "VALID" }, { status: "HELD", order: { holdExpiresAt: { gt: now } } }],
});
