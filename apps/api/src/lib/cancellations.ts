import { Prisma, type PrismaClient } from "@ticketapp/db";
import { formatCents } from "@ticketapp/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Mailer } from "./mailer";

/** As with confirmations, every attempt has to fall within a day of the first, while Resend remembers its key. */
const RETRY_HOURS = 23;
const RETRY_BATCH = 20;
/** A send that hasn't finished in this long was abandoned and can be retaken. */
const CLAIM_MINUTES = 10;
/** Sends give up after this many attempts, so a bad address doesn't retry forever. */
export const MAX_CANCELLATION_ATTEMPTS = 5;
const MAX_ATTEMPTS = MAX_CANCELLATION_ATTEMPTS;

/** The cancellation email as first written, stored until it's sent so retries send it unchanged. */
export interface CancellationEmail {
  to: string;
  subject: string;
  text: string;
}

export function cancellationEmail(order: {
  buyerName: string;
  buyerEmail: string;
  ticketCount: number;
  refundedCents: number;
  event: { name: string; organizationName: string };
}): CancellationEmail {
  const { event } = order;
  const one = order.ticketCount === 1;
  const refunded = order.refundedCents > 0;
  const text = [
    `Hi ${order.buyerName},`,
    "",
    `${event.organizationName} cancelled your ${one ? "ticket" : "tickets"} for ${event.name}. Their QR ${one ? "code no longer works" : "codes no longer work"} at the door.`,
    ...(refunded
      ? [
          "",
          `${formatCents(order.refundedCents)} is on its way back to the card you paid with. It can take 5 to 10 business days to show up.`,
        ]
      : []),
    "",
    `If you have questions, contact ${event.organizationName}.`,
  ].join("\n");
  return {
    to: order.buyerEmail,
    subject: `Your ${one ? "ticket" : "tickets"} for ${event.name} ${one ? "was" : "were"} ${refunded ? "refunded" : "cancelled"}`,
    text,
  };
}

export interface CancellationNotices {
  /** Sends an order's stored cancellation email if it hasn't gone out. Never throws. */
  send(orderId: string): Promise<void>;
  /** Tries again for recent cancellations whose email hasn't gone out. */
  retry(now?: Date): Promise<void>;
}

export function cancellationNotices({
  prisma,
  mailer,
  log,
}: {
  prisma: PrismaClient;
  mailer: Mailer;
  log: FastifyBaseLogger;
}): CancellationNotices {
  async function send(orderId: string) {
    const now = new Date();
    try {
      // Claiming first means two senders (a request and the sweep, or two servers) can't both
      // send it, which matters for SMTP, where there's no idempotency key to drop a repeat.
      const claimExpired = new Date(now.getTime() - CLAIM_MINUTES * 60_000);
      const retriesEnd = new Date(now.getTime() - RETRY_HOURS * 60 * 60_000);
      const count = await prisma.$executeRaw`
        UPDATE "Order" SET
          "cancellationClaimedAt" = ${now},
          "cancellationAttempts" = "cancellationAttempts" + 1
        WHERE id = ${orderId}::uuid
          AND "cancellationEmail" IS NOT NULL
          AND "cancellationAttempts" < ${MAX_ATTEMPTS}
          AND "cancelledAt" > ${retriesEnd}
          AND ("cancellationClaimedAt" IS NULL OR "cancellationClaimedAt" < ${claimExpired})`;
      if (count === 0) return;
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { cancellationEmail: true, cancellationAttempts: true },
      });
      const email = order.cancellationEmail as CancellationEmail | null;
      if (!email) return;
      try {
        // The same key and message on every attempt, so the provider drops a repeat.
        await mailer.send({ ...email, idempotencyKey: `order-cancelled-${orderId}` });
      } catch (err) {
        log.error({ err, orderId }, "Couldn't send the cancellation email");
        const givingUp = order.cancellationAttempts >= MAX_ATTEMPTS;
        // Only release our own claim: a slow attempt mustn't free one a later attempt took over.
        await prisma.order.updateMany({
          where: { id: orderId, cancellationClaimedAt: now },
          data: {
            cancellationClaimedAt: null,
            ...(givingUp ? { cancellationEmail: Prisma.DbNull } : {}),
          },
        });
        return;
      }
      await prisma.order.update({
        where: { id: orderId },
        data: { cancellationEmail: Prisma.DbNull, cancellationClaimedAt: null },
      });
    } catch (err) {
      log.error({ err, orderId }, "Cancellation email failed partway; it will be retried");
    }
  }

  async function retry(now = new Date()) {
    try {
      const retriesEnd = new Date(now.getTime() - RETRY_HOURS * 60 * 60_000);
      const claimExpired = new Date(now.getTime() - CLAIM_MINUTES * 60_000);
      const unclaimed = {
        OR: [{ cancellationClaimedAt: null }, { cancellationClaimedAt: { lt: claimExpired } }],
      };
      // Emails that will never go out now (out of attempts, or past the window, where a retry
      // could be delivered twice) are given up.
      await prisma.order.updateMany({
        where: {
          cancellationEmail: { not: Prisma.DbNull },
          AND: [
            unclaimed,
            {
              OR: [
                { cancellationAttempts: { gte: MAX_ATTEMPTS } },
                { cancelledAt: { lte: retriesEnd } },
              ],
            },
          ],
        },
        data: { cancellationEmail: Prisma.DbNull },
      });
      const orders = await prisma.order.findMany({
        where: {
          cancellationEmail: { not: Prisma.DbNull },
          cancellationAttempts: { lt: MAX_ATTEMPTS },
          cancelledAt: { gt: retriesEnd },
          ...unclaimed,
        },
        select: { id: true },
        // Fewest attempts first, so emails that keep failing can't crowd out the rest.
        orderBy: [{ cancellationAttempts: "asc" }, { cancelledAt: "asc" }, { id: "asc" }],
        take: RETRY_BATCH,
      });
      for (const order of orders) await send(order.id);
    } catch (err) {
      log.error({ err }, "Couldn't look for unsent cancellation emails");
    }
  }

  return { send, retry };
}
