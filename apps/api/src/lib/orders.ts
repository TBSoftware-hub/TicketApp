import type { Prisma, PrismaClient } from "@ticketapp/db";
import type { CheckoutState, Payments } from "./payments";

// Both helpers update the order before its tickets, so they lock rows in the same order and
// can't deadlock with each other.

/** Gives up an unpaid order's seats and its promo code use. */
export async function releaseOrder(tx: Prisma.TransactionClient, orderId: string) {
  const { count } = await tx.order.updateMany({
    where: { id: orderId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  if (count > 0) {
    await tx.ticket.updateMany({ where: { orderId, status: "HELD" }, data: { status: "VOID" } });
  }
}

/** Turns a paid order's held seats into tickets. */
export async function markPaid(
  tx: Prisma.TransactionClient,
  orderId: string,
  paymentIntentId: string | null,
) {
  const { count } = await tx.order.updateMany({
    where: { id: orderId, status: "PENDING" },
    data: { status: "PAID", stripePaymentIntentId: paymentIntentId, holdExpiresAt: null },
  });
  if (count > 0) {
    await tx.ticket.updateMany({ where: { orderId, status: "HELD" }, data: { status: "VALID" } });
  }
}

/** Applies what Stripe says about an order's payment page. An open page changes nothing. */
export async function applyCheckoutState(
  prisma: PrismaClient,
  orderId: string,
  state: CheckoutState,
) {
  if (state.status === "paid") {
    await prisma.$transaction((tx) => markPaid(tx, orderId, state.paymentIntentId));
  } else if (state.status === "expired") {
    await prisma.$transaction((tx) => releaseOrder(tx, orderId));
  }
}

/** How many lapsed orders one checkout settles, so a backlog can't hold up a buyer for long. */
const SETTLE_BATCH = 10;

/**
 * Settles up to a batch of an event's unpaid orders whose hold has run out, oldest first, asking
 * Stripe about each so a payment that came in without the buyer returning still gets its
 * tickets. Each checkout takes the next batch. An order Stripe can't tell us about keeps its
 * seats; the rest are still settled, then the failures are thrown.
 */
export async function settleLapsedHolds(
  prisma: PrismaClient,
  payments: Payments | undefined,
  eventId: string,
  now = new Date(),
) {
  const lapsed = await prisma.order.findMany({
    where: { eventId, status: "PENDING", holdExpiresAt: { lte: now } },
    select: { id: true, stripeCheckoutSessionId: true },
    orderBy: { holdExpiresAt: "asc" },
    take: SETTLE_BATCH,
  });
  const results = await Promise.allSettled(
    lapsed.map(async (order) => {
      if (!order.stripeCheckoutSessionId) {
        // The payment page never opened, so nobody could have paid.
        await prisma.$transaction((tx) => releaseOrder(tx, order.id));
      } else if (payments) {
        await applyCheckoutState(
          prisma,
          order.id,
          await payments.checkoutState(order.stripeCheckoutSessionId),
        );
      }
    }),
  );
  const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  if (failures.length > 0) {
    throw new AggregateError(failures, `Couldn't settle ${failures.length} lapsed orders`);
  }
}
