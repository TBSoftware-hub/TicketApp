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
/** How long an order Stripe couldn't settle waits before it's tried again. */
const SETTLE_RETRY_MINUTES = 5;

/**
 * Settles up to a batch of an event's unpaid orders whose hold has run out, oldest first, asking
 * Stripe about each so a payment that came in without the buyer returning still gets its
 * tickets. An order Stripe can't settle yet keeps its seats and is pushed back for a retry, so it
 * can't stop later orders from reaching the front of the queue. Failures are thrown at the end.
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
  const retryAt = new Date(now.getTime() + SETTLE_RETRY_MINUTES * 60_000);
  const deferred: string[] = [];
  const failures: unknown[] = [];
  await Promise.all(
    lapsed.map(async (order) => {
      try {
        if (!order.stripeCheckoutSessionId) {
          // The payment page never opened, so nobody could have paid.
          await prisma.$transaction((tx) => releaseOrder(tx, order.id));
        } else if (payments) {
          const state = await payments.checkoutState(order.stripeCheckoutSessionId);
          await applyCheckoutState(prisma, order.id, state);
          if (state.status === "open") deferred.push(order.id);
        }
      } catch (err) {
        failures.push(err);
        deferred.push(order.id);
      }
    }),
  );
  if (deferred.length > 0) {
    await prisma.order.updateMany({
      where: { id: { in: deferred }, status: "PENDING" },
      data: { holdExpiresAt: retryAt },
    });
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Couldn't settle ${failures.length} lapsed orders`);
  }
}
