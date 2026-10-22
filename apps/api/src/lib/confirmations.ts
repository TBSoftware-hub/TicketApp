import { Prisma, type PrismaClient } from "@ticketapp/db";
import { formatCents, formatEventTime } from "@ticketapp/shared";
import type { FastifyBaseLogger } from "fastify";
import QRCode from "qrcode";
import type { InlineImage, Mailer, MailMessage } from "./mailer";

/** A send that hasn't finished in this long was abandoned (say, by a restart) and can be retaken. */
const CLAIM_MINUTES = 10;
/**
 * Resend forgets idempotency keys after 24 hours, so every attempt has to fall within this long
 * of the first. Past it, an earlier attempt may have been delivered with no record of it, and a
 * duplicate is worse than a gap the buyer can fill from their order page.
 */
const RETRY_HOURS = 23;
/** Sends give up after this many attempts, so a bad address doesn't retry forever. */
export const MAX_CONFIRMATION_ATTEMPTS = 5;
/** The retry sweep only looks back this far for orders never tried, and at this many per run. */
const RETRY_DAYS = 7;
const RETRY_BATCH = 20;

const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);

/**
 * Orders with no confirmation email being sent right now. Cancelling waits for one in progress,
 * so a buyer can't get working-looking tickets after being told they were cancelled.
 */
export const notSendingConfirmation = (now = new Date()): Prisma.OrderWhereInput => ({
  OR: [
    { confirmationClaimedAt: null },
    { confirmationClaimedAt: { lt: minutesBefore(now, CLAIM_MINUTES) } },
  ],
});

/** The buyer's link to their order, which lets them see, cancel and download it. */
export function orderLink(
  webBaseUrl: string,
  event: { slug: string; organization: { slug: string } },
  orderId: string,
  key: string,
) {
  return `${webBaseUrl}/e/${encodeURIComponent(event.organization.slug)}/${encodeURIComponent(event.slug)}/orders/${orderId}?key=${encodeURIComponent(key)}`;
}

export interface OrderConfirmations {
  /**
   * Emails a paid order's tickets to the buyer, once. Never throws: a failed send is logged and
   * left for `retry` or the buyer's next visit. `viewKey` is the order link's key when the caller
   * has it; otherwise the stored one is used.
   */
  confirm(orderId: string, viewKey?: string): Promise<void>;
  /** Tries again for recent paid orders whose email hasn't gone out. */
  retry(now?: Date): Promise<void>;
}

/** Just the sending half, for routes that confirm orders. */
export type ConfirmOrder = OrderConfirmations["confirm"];

export function orderConfirmations({
  prisma,
  mailer,
  webBaseUrl,
  log,
}: {
  prisma: PrismaClient;
  mailer: Mailer;
  webBaseUrl: string;
  log: FastifyBaseLogger;
}): OrderConfirmations {
  /** Orders that still need their email and that no attempt is working on. */
  const unsent = (now: Date) => ({
    status: "PAID" as const,
    // A door sale with no email has nowhere to go.
    buyerEmail: { not: null },
    confirmationSentAt: null,
    confirmationAttempts: { lt: MAX_CONFIRMATION_ATTEMPTS },
    AND: [
      {
        OR: [
          { confirmationClaimedAt: null },
          { confirmationClaimedAt: { lt: minutesBefore(now, CLAIM_MINUTES) } },
        ],
      },
      {
        OR: [
          { confirmationFirstTriedAt: null },
          { confirmationFirstTriedAt: { gt: minutesBefore(now, RETRY_HOURS * 60) } },
        ],
      },
    ],
  });

  async function confirm(orderId: string, viewKey?: string) {
    const now = new Date();
    let claimed = false;
    try {
      // Claiming first means two requests settling the same order can't both email it. The first
      // claim also fixes when retries have to stop, whatever later attempts do.
      const claimExpired = minutesBefore(now, CLAIM_MINUTES);
      const retriesEnd = minutesBefore(now, RETRY_HOURS * 60);
      const count = await prisma.$executeRaw`
        UPDATE "Order" SET
          "confirmationClaimedAt" = ${now},
          "confirmationAttempts" = "confirmationAttempts" + 1,
          "confirmationFirstTriedAt" = COALESCE("confirmationFirstTriedAt", ${now})
        WHERE id = ${orderId}::uuid
          AND status = 'PAID'
          AND "buyerEmail" IS NOT NULL
          AND "confirmationSentAt" IS NULL
          AND "confirmationAttempts" < ${MAX_CONFIRMATION_ATTEMPTS}
          AND ("confirmationClaimedAt" IS NULL OR "confirmationClaimedAt" < ${claimExpired})
          AND ("confirmationFirstTriedAt" IS NULL OR "confirmationFirstTriedAt" > ${retriesEnd})`;
      if (count === 0) return;
      claimed = true;
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          buyerName: true,
          buyerEmail: true,
          totalCents: true,
          emailViewKey: true,
          confirmationEmail: true,
          confirmationAttempts: true,
          event: {
            select: {
              name: true,
              slug: true,
              startsAt: true,
              endsAt: true,
              venue: true,
              organization: { select: { name: true, slug: true, timezone: true } },
            },
          },
          tickets: {
            where: { status: "VALID" },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: {
              code: true,
              ticketType: { select: { name: true } },
              attendee: { select: { firstName: true, lastName: true } },
            },
          },
        },
      });
      // A retry replays the first attempt's email: the provider rejects a reused idempotency key
      // with a different message, which an edit to the event in between would cause.
      let snapshot = order.confirmationEmail as EmailSnapshot | null;
      if (!snapshot) {
        // The stored key first: a resend may have replaced the one this caller was given.
        const key = order.emailViewKey ?? viewKey;
        const { event } = order;
        const orderUrl = key ? orderLink(webBaseUrl, event, orderId, key) : null;
        // The claim only takes orders with an email.
        snapshot = renderConfirmation({ ...order, buyerEmail: order.buyerEmail ?? "", orderUrl });
        await prisma.order.updateMany({
          where: { id: orderId, confirmationClaimedAt: now },
          data: { confirmationEmail: snapshot as unknown as Prisma.InputJsonObject },
        });
      }
      const { codes, ...rendered } = snapshot;
      const message: MailMessage = { ...rendered, inlineImages: await qrImages(codes) };
      try {
        // The same key on every attempt, so a retry after an unclear failure isn't delivered twice.
        await mailer.send({ ...message, idempotencyKey: `order-confirmation-${orderId}` });
      } catch (err) {
        log.error({ err, orderId }, "Couldn't send the order confirmation");
        const givingUp = order.confirmationAttempts >= MAX_CONFIRMATION_ATTEMPTS;
        // Only release our own claim: a slow attempt mustn't free one a later attempt took over.
        await prisma.order.updateMany({
          where: { id: orderId, confirmationClaimedAt: now },
          // The key is only kept for the email; once it won't be sent, it goes.
          data: {
            confirmationClaimedAt: null,
            ...(givingUp ? { emailViewKey: null, confirmationEmail: Prisma.DbNull } : {}),
          },
        });
        return;
      }
      // Sent. If recording that fails, the claim stays and expires, and the retried send carries
      // the same idempotency key.
      await prisma.order.update({
        where: { id: orderId },
        data: {
          confirmationSentAt: new Date(),
          confirmationClaimedAt: null,
          emailViewKey: null,
          confirmationEmail: Prisma.DbNull,
        },
      });
    } catch (err) {
      log.error(
        { err, orderId },
        claimed
          ? "Order confirmation failed partway; it will be retried"
          : "Couldn't claim the order confirmation",
      );
    }
  }

  async function retry(now = new Date()) {
    try {
      // Orders that will never be emailed now (out of attempts or past the retry window) don't
      // keep the order key, however their last attempt ended.
      await prisma.order.updateMany({
        where: {
          status: "PAID",
          confirmationSentAt: null,
          OR: [{ emailViewKey: { not: null } }, { confirmationEmail: { not: Prisma.DbNull } }],
          AND: [
            {
              OR: [
                { confirmationAttempts: { gte: MAX_CONFIRMATION_ATTEMPTS } },
                { confirmationFirstTriedAt: { lte: minutesBefore(now, RETRY_HOURS * 60) } },
              ],
            },
            {
              OR: [
                { confirmationClaimedAt: null },
                { confirmationClaimedAt: { lt: minutesBefore(now, CLAIM_MINUTES) } },
              ],
            },
          ],
        },
        data: { emailViewKey: null, confirmationEmail: Prisma.DbNull },
      });
      const orders = await prisma.order.findMany({
        where: {
          ...unsent(now),
          // The age limit is for orders never tried; one already started gets its full retry window.
          OR: [
            { confirmationFirstTriedAt: { not: null } },
            { createdAt: { gte: minutesBefore(now, RETRY_DAYS * 24 * 60) } },
          ],
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: RETRY_BATCH,
      });
      for (const order of orders) await confirm(order.id);
    } catch (err) {
      log.error({ err }, "Couldn't look for unsent order confirmations");
    }
  }

  return { confirm, retry };
}

export interface ConfirmationOrder {
  buyerName: string;
  buyerEmail: string;
  totalCents: number;
  orderUrl: string | null;
  event: {
    name: string;
    startsAt: Date;
    endsAt: Date;
    venue: string | null;
    organization: { name: string; timezone: string };
  };
  tickets: {
    code: string;
    ticketType: { name: string };
    attendee: { firstName: string; lastName: string };
  }[];
}

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** A rendered confirmation, stored so retries send it unchanged. The QR images are redrawn from `codes`. */
interface EmailSnapshot {
  to: string;
  subject: string;
  text: string;
  html: string;
  codes: string[];
}

/** One QR code image per ticket, referenced from the email's HTML as `cid:ticket-N`. */
function qrImages(codes: string[]): Promise<InlineImage[]> {
  return Promise.all(
    codes.map(async (code, i) => ({
      filename: `ticket-${i + 1}.png`,
      content: await QRCode.toBuffer(code, { type: "png", width: 240, margin: 2 }),
      contentType: "image/png",
      contentId: `ticket-${i + 1}`,
    })),
  );
}

/** The confirmation email: one QR code per ticket, shown inline so it works offline at the door. */
export async function confirmationEmail(order: ConfirmationOrder): Promise<MailMessage> {
  const { codes, ...rendered } = renderConfirmation(order);
  return { ...rendered, inlineImages: await qrImages(codes) };
}

function renderConfirmation(order: ConfirmationOrder): EmailSnapshot {
  const { event, tickets } = order;
  const when = formatEventTime(event.startsAt, event.endsAt, event.organization.timezone);
  const plural = tickets.length === 1 ? "ticket" : "tickets";
  const holder = (t: (typeof tickets)[number]) => `${t.attendee.firstName} ${t.attendee.lastName}`;
  const total = order.totalCents > 0 ? `Total paid: ${formatCents(order.totalCents)}` : null;

  const text = [
    `Hi ${order.buyerName},`,
    "",
    `Your ${plural} for ${event.name} (${event.organization.name}) ${tickets.length === 1 ? "is" : "are"} confirmed.`,
    `When: ${when}`,
    ...(event.venue ? [`Where: ${event.venue}`] : []),
    "",
    ...tickets.map((t) => `- ${holder(t)}: ${t.ticketType.name}`),
    "",
    `Show each ticket's QR code at the door. The codes are images in this email, so turn images on if you can't see them.`,
    ...(total ? ["", total] : []),
    ...(order.orderUrl ? ["", `Your order: ${order.orderUrl}`] : []),
  ].join("\n");

  const ticketBlocks = tickets
    .map(
      (t, i) => `
      <tr><td style="padding:16px 0;border-top:1px solid #ddd;text-align:center">
        <img src="cid:ticket-${i + 1}" width="240" height="240" alt="QR code for ${escape(holder(t))}'s ticket" style="display:block;margin:0 auto">
        <p style="margin:8px 0 0;font-size:16px"><strong>${escape(holder(t))}</strong></p>
        <p style="margin:4px 0 0;color:#555">${escape(t.ticketType.name)}</p>
      </td></tr>`,
    )
    .join("");
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#111">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;border-collapse:collapse">
    <tr><td>
      <p style="margin:0;color:#555">${escape(event.organization.name)}</p>
      <h1 style="margin:4px 0 12px;font-size:22px">${escape(event.name)}</h1>
      <p style="margin:0">${escape(when)}</p>
      ${event.venue ? `<p style="margin:4px 0 0">${escape(event.venue)}</p>` : ""}
      <p style="margin:16px 0">Hi ${escape(order.buyerName)}, your ${plural} ${tickets.length === 1 ? "is" : "are"} confirmed. Show each QR code at the door.</p>
    </td></tr>${ticketBlocks}
    ${total ? `<tr><td style="padding:16px 0;border-top:1px solid #ddd">${escape(total)}</td></tr>` : ""}
    ${order.orderUrl ? `<tr><td style="padding:8px 0"><a href="${escape(order.orderUrl)}">View your order</a></td></tr>` : ""}
  </table>
</body></html>`;

  return {
    to: order.buyerEmail,
    subject: `Your ${plural} for ${event.name}`,
    text,
    html,
    codes: tickets.map((t) => t.code),
  };
}
