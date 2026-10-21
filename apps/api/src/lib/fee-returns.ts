import type { PrismaClient } from "@ticketapp/db";
import type { FastifyBaseLogger } from "fastify";
import type { Payments } from "./payments";

/** Stops trying after this long; anything still owed by then needs a look in Stripe. */
const RETRY_DAYS = 30;
const RETRY_BATCH = 20;

export interface FeeReturns {
  /** Hands a refunded order's service fee back to the school, if it's still owed. Never throws. */
  send(orderId: string): Promise<void>;
  /** Tries again for recent refunds whose service fee hasn't gone back yet. */
  retry(now?: Date): Promise<void>;
}

/**
 * The service fee is only earned on tickets that are kept, so a refund hands it back to the
 * school. It's sent after the order is cancelled, so a Stripe hiccup here can't leave a refunded
 * order looking paid; whatever is still owed is retried until Stripe takes it.
 */
export function feeReturns({
  prisma,
  payments,
  log,
}: {
  prisma: PrismaClient;
  payments?: Payments;
  log: FastifyBaseLogger;
}): FeeReturns {
  async function send(orderId: string) {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { feeReturnDueCents: true, stripePaymentIntentId: true },
      });
      if (!payments || !order?.stripePaymentIntentId || order.feeReturnDueCents <= 0) return;
      const due = order.feeReturnDueCents;
      // Stripe only sends what hasn't gone back yet, so two senders at once can't send it twice.
      await payments.returnFee({
        orderId,
        paymentIntentId: order.stripePaymentIntentId,
        cents: due,
      });
      await prisma.order.updateMany({
        where: { id: orderId, feeReturnDueCents: due },
        data: { feeReturnDueCents: 0 },
      });
    } catch (err) {
      log.error({ err, orderId }, "Couldn't return the service fee; it will be retried");
    }
  }

  async function retry(now = new Date()) {
    if (!payments) return;
    try {
      const orders = await prisma.order.findMany({
        where: {
          feeReturnDueCents: { gt: 0 },
          cancelledAt: { gt: new Date(now.getTime() - RETRY_DAYS * 24 * 60 * 60_000) },
        },
        select: { id: true },
        orderBy: [{ cancelledAt: "asc" }, { id: "asc" }],
        take: RETRY_BATCH,
      });
      for (const order of orders) await send(order.id);
    } catch (err) {
      log.error({ err }, "Couldn't look for service fees still owed");
    }
  }

  return { send, retry };
}
