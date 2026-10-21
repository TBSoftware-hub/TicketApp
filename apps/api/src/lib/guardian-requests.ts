import { Prisma, type PrismaClient } from "@ticketapp/db";
import { formatEventTime } from "@ticketapp/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Mailer } from "./mailer";
import type { Texter } from "./texter";

/** A send that hasn't finished in this long was abandoned (say, by a restart) and can be retaken. */
const CLAIM_MINUTES = 10;
/** Resend forgets idempotency keys after 24 hours, so retries stop before then. */
const RETRY_HOURS = 23;
/** Sends give up after this many attempts, so a bad address doesn't retry forever. */
export const MAX_GUARDIAN_REQUEST_ATTEMPTS = 5;
/** The retry sweep only looks back this far for requests never tried, and at this many per run. */
const RETRY_DAYS = 7;
const RETRY_BATCH = 20;

const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);

/**
 * Requests with a send in progress for an order. Cancelling waits for them, so a guardian isn't
 * sent a link for tickets that were just voided.
 */
export const sendingGuardianRequest = (
  orderId: string,
  now = new Date(),
): Prisma.GuardianSignatureRequestWhereInput => ({
  ticket: { orderId },
  sendClaimedAt: { gte: minutesBefore(now, CLAIM_MINUTES) },
});

/** The messages carrying a guardian's signing link, stored until they're sent. */
export interface GuardianMessages {
  /** What the request was about, for the notification log; the link stays out of it. */
  summary: string;
  email?: { to: string; subject: string; text: string; html: string };
  text?: { to: string; body: string };
}

export interface GuardianRequests {
  /** Sends the signing links for a paid order's minors. Never throws; failures are retried. */
  send(orderId: string): Promise<void>;
  /** Tries again for recent requests whose messages haven't all gone out. */
  retry(now?: Date): Promise<void>;
}

export function guardianRequests({
  prisma,
  mailer,
  texter,
  log,
}: {
  prisma: PrismaClient;
  mailer: Mailer;
  texter?: Texter;
  log: FastifyBaseLogger;
}): GuardianRequests {
  async function sendOne(requestId: string) {
    const now = new Date();
    let claimed = false;
    try {
      const claimExpired = minutesBefore(now, CLAIM_MINUTES);
      const retriesEnd = minutesBefore(now, RETRY_HOURS * 60);
      // Claiming first means two requests settling the same order can't both send the link.
      const count = await prisma.$transaction(async (tx) => {
        // Shares the lock cancelling takes, so the order can't be cancelled between this check and
        // the claim; cancelling then waits for the claim to be released.
        const [order] = await tx.$queryRaw<{ id: string }[]>`
          SELECT o.id FROM "GuardianSignatureRequest" r
          JOIN "Ticket" t ON t.id = r."ticketId"
          JOIN "Order" o ON o.id = t."orderId"
          WHERE r.id = ${requestId}::uuid
          FOR SHARE OF o`;
        if (!order) return 0;
        return tx.$executeRaw`
        UPDATE "GuardianSignatureRequest" r SET
          "sendClaimedAt" = ${now},
          "sendAttempts" = r."sendAttempts" + 1,
          "sendFirstTriedAt" = COALESCE(r."sendFirstTriedAt", ${now})
        FROM "Ticket" t
        JOIN "Order" o ON o.id = t."orderId"
        JOIN "Event" e ON e.id = t."eventId"
        WHERE r.id = ${requestId}::uuid
          AND e."endsAt" > ${now}
          AND e.status <> 'CANCELLED'
          AND t.id = r."ticketId"
          AND o.status = 'PAID'
          AND t.status = 'VALID'
          AND r."pendingMessages" IS NOT NULL
          AND r."signedAt" IS NULL
          AND r."sendAttempts" < ${MAX_GUARDIAN_REQUEST_ATTEMPTS}
          AND (r."sendClaimedAt" IS NULL OR r."sendClaimedAt" < ${claimExpired})
          AND (r."sendFirstTriedAt" IS NULL OR r."sendFirstTriedAt" > ${retriesEnd})`;
      });
      if (count === 0) return;
      claimed = true;
      const request = await prisma.guardianSignatureRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: {
          guardianId: true,
          pendingMessages: true,
          emailSentAt: true,
          textSentAt: true,
          sendAttempts: true,
        },
      });
      const messages = request.pendingMessages as unknown as GuardianMessages;
      let emailDone = !messages.email || request.emailSentAt !== null;
      let textDone = !messages.text || request.textSentAt !== null;
      if (!emailDone && messages.email) {
        try {
          // The same key on every attempt, so a retry after an unclear failure isn't delivered twice.
          await mailer.send({ ...messages.email, idempotencyKey: `guardian-request-${requestId}` });
          // Done only once it's recorded; a retry after a failed record reuses the idempotency key.
          await sent(requestId, request.guardianId, "EMAIL", messages.email.to, messages.summary);
          emailDone = true;
        } catch (err) {
          log.error({ err, requestId }, "Couldn't email the guardian signature request");
        }
      }
      if (!textDone && messages.text && texter) {
        try {
          await texter.send(messages.text);
          await sent(requestId, request.guardianId, "SMS", messages.text.to, messages.summary);
          textDone = true;
        } catch (err) {
          log.error({ err, requestId }, "Couldn't text the guardian signature request");
        }
      }
      const givingUp = request.sendAttempts >= MAX_GUARDIAN_REQUEST_ATTEMPTS;
      // Only release our own claim: a slow attempt mustn't free one a later attempt took over. The
      // messages carry a working link, so they go once they've been sent or won't be.
      await prisma.guardianSignatureRequest.updateMany({
        where: { id: requestId, sendClaimedAt: now },
        data: {
          sendClaimedAt: null,
          ...((emailDone && textDone) || givingUp ? { pendingMessages: Prisma.DbNull } : {}),
        },
      });
    } catch (err) {
      log.error(
        { err, requestId },
        claimed
          ? "Guardian signature request failed partway; it will be retried"
          : "Couldn't claim the guardian signature request",
      );
    }
  }

  /** Records a message that went out, in the request and the notification log. */
  async function sent(
    requestId: string,
    guardianId: string,
    channel: "EMAIL" | "SMS",
    to: string,
    summary: string,
  ) {
    const at = new Date();
    await prisma.$transaction([
      prisma.guardianSignatureRequest.update({
        where: { id: requestId },
        data: channel === "EMAIL" ? { emailSentAt: at } : { textSentAt: at },
      }),
      prisma.notification.create({
        data: { guardianId, channel, to, body: summary, status: "SENT" },
      }),
    ]);
  }

  async function send(orderId: string) {
    try {
      const requests = await prisma.guardianSignatureRequest.findMany({
        where: { ticket: { orderId }, pendingMessages: { not: Prisma.DbNull } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      for (const request of requests) await sendOne(request.id);
    } catch (err) {
      log.error({ err, orderId }, "Couldn't look up the order's guardian signature requests");
    }
  }

  async function retry(now = new Date()) {
    try {
      // Requests that will never be sent now don't keep their working link around.
      await prisma.guardianSignatureRequest.updateMany({
        where: {
          pendingMessages: { not: Prisma.DbNull },
          AND: [
            {
              OR: [
                { sendAttempts: { gte: MAX_GUARDIAN_REQUEST_ATTEMPTS } },
                { sendFirstTriedAt: { lte: minutesBefore(now, RETRY_HOURS * 60) } },
                { signedAt: { not: null } },
                { ticket: { status: "VOID" } },
                // Once the event is over the link no longer works, so there's no point sending it.
                { ticket: { event: { endsAt: { lte: now } } } },
                { ticket: { event: { status: "CANCELLED" } } },
                { ticket: { order: { status: { in: ["CANCELLED", "REFUNDED"] } } } },
              ],
            },
            {
              OR: [
                { sendClaimedAt: null },
                { sendClaimedAt: { lt: minutesBefore(now, CLAIM_MINUTES) } },
              ],
            },
          ],
        },
        data: { pendingMessages: Prisma.DbNull },
      });
      const requests = await prisma.guardianSignatureRequest.findMany({
        where: {
          pendingMessages: { not: Prisma.DbNull },
          signedAt: null,
          sendAttempts: { lt: MAX_GUARDIAN_REQUEST_ATTEMPTS },
          ticket: {
            status: "VALID",
            order: { status: "PAID" },
            event: { endsAt: { gt: now }, status: { not: "CANCELLED" } },
          },
          AND: [
            {
              OR: [
                { sendClaimedAt: null },
                { sendClaimedAt: { lt: minutesBefore(now, CLAIM_MINUTES) } },
              ],
            },
            {
              OR: [
                { sendFirstTriedAt: { gt: minutesBefore(now, RETRY_HOURS * 60) } },
                // The age limit is for requests never tried; one already started gets its window.
                {
                  sendFirstTriedAt: null,
                  createdAt: { gte: minutesBefore(now, RETRY_DAYS * 24 * 60) },
                },
              ],
            },
          ],
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: RETRY_BATCH,
      });
      for (const request of requests) await sendOne(request.id);
    } catch (err) {
      log.error({ err }, "Couldn't look for unsent guardian signature requests");
    }
  }

  return { send, retry };
}

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** "A", "A and B", "A, B and C". */
function list(items: string[]) {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface GuardianRequestDetails {
  guardian: { name: string; email: string | null; phone: string | null };
  buyer: { name: string; email: string };
  attendee: { firstName: string; lastName: string };
  event: {
    name: string;
    startsAt: Date;
    endsAt: Date;
    organization: { name: string; timezone: string };
  };
  waiverTitles: string[];
  url: string;
  /** Whether texts can be sent; without it a phone number gets no message. */
  texts: boolean;
}

/** The email and text asking a guardian to sign. */
export function renderGuardianRequest(d: GuardianRequestDetails): GuardianMessages {
  const { guardian, attendee, event } = d;
  const fullName = `${attendee.firstName} ${attendee.lastName}`;
  const when = formatEventTime(event.startsAt, event.endsAt, event.organization.timezone);
  const titles = list(d.waiverTitles.map((t) => `“${t}”`));
  // A parent buying for their own child is told it's their own order.
  const ownOrder = guardian.email !== null && guardian.email === d.buyer.email;
  const who = ownOrder ? "You" : d.buyer.name;
  const messages: GuardianMessages = {
    summary: `Asked to sign ${titles} for ${fullName} (${event.name})`,
  };
  if (guardian.email) {
    const text = [
      `Hi ${guardian.name},`,
      "",
      `${who} got a ticket for ${fullName} to ${event.name} (${event.organization.name}), ${when}.`,
      "",
      `Because ${attendee.firstName} is under 18, a parent or guardian needs to sign ${titles}. Read and sign here:`,
      d.url,
      "",
      "The link works until the event ends. If you weren't expecting this, you can ignore it.",
    ].join("\n");
    const html = `<!doctype html>
<html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#111">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;border-collapse:collapse">
    <tr><td>
      <p style="margin:0;color:#555">${escape(event.organization.name)}</p>
      <h1 style="margin:4px 0 12px;font-size:22px">${escape(event.name)}</h1>
      <p style="margin:0">${escape(when)}</p>
      <p style="margin:16px 0">Hi ${escape(guardian.name)}, ${escape(who)} got a ticket for <strong>${escape(fullName)}</strong>. Because ${escape(attendee.firstName)} is under 18, a parent or guardian needs to sign ${escape(titles)}.</p>
      <p style="margin:16px 0"><a href="${escape(d.url)}" style="display:inline-block;padding:12px 20px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px">Read and sign</a></p>
      <p style="margin:16px 0;color:#555;font-size:14px">The link works until the event ends. If you weren't expecting this, you can ignore it.</p>
    </td></tr>
  </table>
</body></html>`;
    messages.email = {
      to: guardian.email,
      subject: `Please sign for ${attendee.firstName} to go to ${event.name}`,
      text,
      html,
    };
  }
  if (guardian.phone && d.texts) {
    messages.text = {
      to: guardian.phone,
      body: `${event.organization.name}: ${who} got a ticket for ${fullName} to ${event.name}. As their parent or guardian, please sign here: ${d.url}`,
    };
  }
  return messages;
}
