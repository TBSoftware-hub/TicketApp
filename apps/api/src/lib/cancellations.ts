import { Prisma, type PrismaClient } from "@ticketapp/db";
import { formatCents } from "@ticketapp/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Mailer } from "./mailer";

/** As with confirmations, every attempt has to fall within a day of the first, while Resend remembers its key. */
const RETRY_HOURS = 23;
const RETRY_BATCH = 20;

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
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { cancellationEmail: true },
      });
      const email = order?.cancellationEmail as CancellationEmail | null | undefined;
      if (!email) return;
      // The same key and message on every attempt, so the provider drops a repeat.
      await mailer.send({ ...email, idempotencyKey: `order-cancelled-${orderId}` });
      await prisma.order.update({
        where: { id: orderId },
        data: { cancellationEmail: Prisma.DbNull },
      });
    } catch (err) {
      log.error({ err, orderId }, "Couldn't send the cancellation email; it will be retried");
    }
  }

  async function retry(now = new Date()) {
    try {
      const cutoff = new Date(now.getTime() - RETRY_HOURS * 60 * 60_000);
      // Past the window a retry could be delivered twice, so those are given up.
      await prisma.order.updateMany({
        where: { cancellationEmail: { not: Prisma.DbNull }, cancelledAt: { lte: cutoff } },
        data: { cancellationEmail: Prisma.DbNull },
      });
      const orders = await prisma.order.findMany({
        where: { cancellationEmail: { not: Prisma.DbNull }, cancelledAt: { gt: cutoff } },
        select: { id: true },
        orderBy: { cancelledAt: "asc" },
        take: RETRY_BATCH,
      });
      for (const order of orders) await send(order.id);
    } catch (err) {
      log.error({ err }, "Couldn't look for unsent cancellation emails");
    }
  }

  return { send, retry };
}
