import type { PrismaClient } from "@ticketapp/db";
import { formatCents, formatEventTime } from "@ticketapp/shared";
import type { FastifyBaseLogger } from "fastify";
import QRCode from "qrcode";
import type { InlineImage, Mailer, MailMessage } from "./mailer";

/**
 * Emails a paid order's tickets to the buyer, once. Never throws: a failed send is logged and
 * left for the next attempt (the buyer opening their order, or a later settlement) to retry.
 * `viewKey` is the order link's key when the caller has it; otherwise the stored one is used.
 */
export type ConfirmOrder = (orderId: string, viewKey?: string) => Promise<void>;

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
}): ConfirmOrder {
  return async (orderId, viewKey) => {
    // Claiming the send first means two requests settling the same order can't both email it.
    const { count } = await prisma.order.updateMany({
      where: { id: orderId, status: "PAID", confirmationSentAt: null },
      data: { confirmationSentAt: new Date() },
    });
    if (count === 0) return;
    try {
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          buyerName: true,
          buyerEmail: true,
          totalCents: true,
          emailViewKey: true,
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
            orderBy: { createdAt: "asc" },
            select: {
              code: true,
              ticketType: { select: { name: true } },
              attendee: { select: { firstName: true, lastName: true } },
            },
          },
        },
      });
      const key = viewKey ?? order.emailViewKey;
      const { event } = order;
      const orderUrl = key
        ? `${webBaseUrl}/e/${encodeURIComponent(event.organization.slug)}/${encodeURIComponent(event.slug)}/orders/${orderId}?key=${encodeURIComponent(key)}`
        : null;
      await mailer.send(await confirmationEmail({ ...order, orderUrl }));
      await prisma.order.update({ where: { id: orderId }, data: { emailViewKey: null } });
    } catch (err) {
      log.error({ err, orderId }, "Couldn't send the order confirmation");
      await prisma.order
        .update({ where: { id: orderId }, data: { confirmationSentAt: null } })
        .catch((resetErr) => log.error({ err: resetErr, orderId }, "Couldn't reset the send"));
    }
  };
}

interface ConfirmationOrder {
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

/** The confirmation email: one QR code per ticket, shown inline so it works offline at the door. */
export async function confirmationEmail(order: ConfirmationOrder): Promise<MailMessage> {
  const { event, tickets } = order;
  const when = formatEventTime(event.startsAt, event.endsAt, event.organization.timezone);
  const plural = tickets.length === 1 ? "ticket" : "tickets";
  const images: InlineImage[] = await Promise.all(
    tickets.map(async (ticket, i) => ({
      filename: `ticket-${i + 1}.png`,
      content: await QRCode.toBuffer(ticket.code, { type: "png", width: 240, margin: 2 }),
      contentType: "image/png",
      contentId: `ticket-${i + 1}`,
    })),
  );
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
    inlineImages: images,
  };
}
