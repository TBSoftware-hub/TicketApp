import { Prisma, type PrismaClient } from "@ticketapp/db";
import { formatEventTime } from "@ticketapp/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Mailer } from "./mailer";
import type { Texter } from "./texter";
import { generateToken, hashToken } from "./tokens";

/** A send that hasn't finished in this long was abandoned (say, by a restart) and can be retaken. */
const CLAIM_MINUTES = 10;
/** Resend forgets idempotency keys after 24 hours, so retries stop before then. */
const RETRY_HOURS = 23;
/** Sends give up after this many attempts, so a bad address doesn't retry forever. */
export const MAX_GUARDIAN_REQUEST_ATTEMPTS = 5;
/** The retry sweep only looks back this far for requests never tried, and at this many per run. */
const RETRY_DAYS = 7;
const RETRY_BATCH = 20;

/** A guardian who hasn't signed is reminded at most this many times. */
export const MAX_GUARDIAN_REMINDERS = 2;
/** A reminder goes out once the last message has had this long to be acted on... */
export const REMINDER_AFTER_HOURS = 48;
/** ...or, once the event is this close, after a shorter wait. */
export const REMINDER_LAST_DAY_HOURS = 24;
const REMINDER_LAST_DAY_GAP_HOURS = 12;

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
  /**
   * Tries again for recent requests whose messages haven't all gone out, then reminds guardians
   * who still haven't signed.
   */
  retry(now?: Date): Promise<void>;
  /**
   * Queues the reminder after `round` with a fresh link, unless the request moved on first.
   * Returns whether it did. The sweep calls it; it's exposed so tests can race it.
   */
  queueReminder(requestId: string, round: number): Promise<boolean>;
}

export function guardianRequests({
  prisma,
  mailer,
  texter,
  log,
  webBaseUrl,
}: {
  prisma: PrismaClient;
  mailer: Mailer;
  texter?: Texter;
  log: FastifyBaseLogger;
  webBaseUrl: string;
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
          -- A reminder is about getting it signed before the event, so it stops when the event starts.
          AND (r."remindersSent" = 0 OR e."startsAt" > ${now})
          AND (r."sendClaimedAt" IS NULL OR r."sendClaimedAt" < ${claimExpired})
          AND (r."sendFirstTriedAt" IS NULL OR r."sendFirstTriedAt" > ${retriesEnd})`;
      });
      if (count === 0) return;
      claimed = true;
      const request = await prisma.guardianSignatureRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: {
          id: true,
          guardianId: true,
          pendingMessages: true,
          emailSentAt: true,
          textSentAt: true,
          sendAttempts: true,
          remindersSent: true,
        },
      });
      const messages = request.pendingMessages as unknown as GuardianMessages | null;
      // Signing in the meantime clears the messages; there's nothing left to send.
      if (!messages) {
        await release(requestId, now);
        return;
      }
      let emailDone = !messages.email || request.emailSentAt !== null;
      let textDone = !messages.text || request.textSentAt !== null;
      if (!emailDone && messages.email) {
        try {
          // The same key on every attempt, so a retry after an unclear failure isn't delivered twice.
          const round = request.remindersSent ? `-reminder-${request.remindersSent}` : "";
          await mailer.send({
            ...messages.email,
            idempotencyKey: `guardian-request-${requestId}${round}`,
          });
          // Done only once it's recorded; a retry after a failed record reuses the idempotency key.
          await sent(request, now, "EMAIL", messages.email.to, messages.summary);
          emailDone = true;
        } catch (err) {
          log.error({ err, requestId }, "Couldn't email the guardian signature request");
        }
      }
      if (!textDone && messages.text && texter) {
        try {
          await texter.send(messages.text);
          await sent(request, now, "SMS", messages.text.to, messages.summary);
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
      // A claim left behind would hold up cancelling the order until it expired.
      if (claimed) await release(requestId, now).catch(() => {});
    }
  }

  /** Frees this attempt's claim, and only this attempt's: a later attempt may have taken over. */
  function release(requestId: string, claimedAt: Date) {
    return prisma.guardianSignatureRequest.updateMany({
      where: { id: requestId, sendClaimedAt: claimedAt },
      data: { sendClaimedAt: null },
    });
  }

  /**
   * Records a message that went out, in the request and the notification log. The round's send
   * fields only change while this attempt still holds its claim on the same round: a send that
   * finished after its claim expired mustn't mark a newer round as done. The delivery times are
   * history, so they're kept either way, and a reminder counts as delivered once it reaches
   * either channel.
   */
  async function sent(
    request: { id: string; guardianId: string; remindersSent: number },
    claimedAt: Date,
    channel: "EMAIL" | "SMS",
    to: string,
    summary: string,
  ) {
    const at = new Date();
    const ours = { id: request.id, remindersSent: request.remindersSent, sendClaimedAt: claimedAt };
    await prisma.$transaction([
      // Counted on the round's first channel to get through, before that's recorded below.
      ...(request.remindersSent > 0
        ? [
            prisma.guardianSignatureRequest.updateMany({
              where: { ...ours, emailSentAt: null, textSentAt: null },
              data: { remindersDelivered: { increment: 1 } },
            }),
          ]
        : []),
      prisma.guardianSignatureRequest.updateMany({
        where: ours,
        data: channel === "EMAIL" ? { emailSentAt: at } : { textSentAt: at },
      }),
      prisma.guardianSignatureRequest.update({
        where: { id: request.id },
        data: channel === "EMAIL" ? { emailDeliveredAt: at } : { textDeliveredAt: at },
      }),
      prisma.notification.create({
        data: { guardianId: request.guardianId, channel, to, body: summary, status: "SENT" },
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
                { remindersSent: { gt: 0 }, ticket: { event: { startsAt: { lte: now } } } },
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
                // A reminder is queued long after the request was made, so it isn't held to that.
                { sendFirstTriedAt: null, remindersSent: { gt: 0 } },
              ],
            },
            { OR: [{ remindersSent: 0 }, { ticket: { event: { startsAt: { gt: now } } } }] },
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
    await remind(now);
  }

  /**
   * Sends a fresh link to guardians who haven't signed: two days after the first message, and
   * again in the last day before the event, up to MAX_GUARDIAN_REMINDERS times.
   */
  async function remind(now: Date) {
    try {
      const lastDay = new Date(now.getTime() + REMINDER_LAST_DAY_HOURS * 60 * 60_000);
      // Delivery times survive a failed round, so a reminder that never arrived still leaves the
      // last-day reminder to come.
      const due = await prisma.$queryRaw<{ id: string; remindersSent: number }[]>`
        SELECT r.id, r."remindersSent" FROM "GuardianSignatureRequest" r
        JOIN "Ticket" t ON t.id = r."ticketId"
        JOIN "Order" o ON o.id = t."orderId"
        JOIN "Event" e ON e.id = t."eventId"
        JOIN "Guardian" g ON g.id = r."guardianId"
        WHERE r."signedAt" IS NULL
          AND r."pendingMessages" IS NULL
          -- Someone only reachable by text can't be reminded while texts are off.
          AND (g.email IS NOT NULL OR (g.phone IS NOT NULL AND ${Boolean(texter)}))
          AND r."remindersSent" < ${MAX_GUARDIAN_REMINDERS}
          AND (r."sendClaimedAt" IS NULL OR r."sendClaimedAt" < ${minutesBefore(now, CLAIM_MINUTES)})
          AND t.status = 'VALID'
          AND o.status = 'PAID'
          AND e.status <> 'CANCELLED'
          AND e."startsAt" > ${now}
          AND GREATEST(r."emailDeliveredAt", r."textDeliveredAt") IS NOT NULL
          AND (
            -- Only the first reminder comes two days on; the second is kept for the last day.
            (r."remindersSent" = 0
              AND GREATEST(r."emailDeliveredAt", r."textDeliveredAt") <= ${minutesBefore(now, REMINDER_AFTER_HOURS * 60)})
            OR (
              e."startsAt" <= ${lastDay}
              AND GREATEST(r."emailDeliveredAt", r."textDeliveredAt") <= ${minutesBefore(now, REMINDER_LAST_DAY_GAP_HOURS * 60)}
            )
          )
        ORDER BY r."createdAt"
        LIMIT ${RETRY_BATCH}`;
      for (const { id, remindersSent } of due) {
        try {
          if (await queueReminder(id, remindersSent)) await sendOne(id);
        } catch (err) {
          log.error({ err, requestId: id }, "Couldn't remind the guardian to sign");
        }
      }
    } catch (err) {
      log.error({ err }, "Couldn't look for guardians to remind");
    }
  }

  /** Renders a reminder with its own link and queues it, unless something got there first. */
  async function queueReminder(requestId: string, round: number) {
    const request = await prisma.guardianSignatureRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: {
        guardian: { select: { name: true, email: true, phone: true } },
        ticket: {
          select: {
            attendee: { select: { firstName: true, lastName: true } },
            order: { select: { buyerName: true, buyerEmail: true } },
            event: {
              select: {
                name: true,
                startsAt: true,
                endsAt: true,
                organization: { select: { name: true, timezone: true } },
              },
            },
            signatures: {
              where: { signerRole: "ATTENDEE" },
              select: { waiverTemplateId: true, templateVersion: true },
            },
          },
        },
      },
    });
    const { ticket } = request;
    const versions = ticket.signatures.length
      ? await prisma.waiverTemplateVersion.findMany({
          where: {
            requiresGuardianForMinors: true,
            OR: ticket.signatures.map((s) => ({
              waiverTemplateId: s.waiverTemplateId,
              version: s.templateVersion,
            })),
          },
          select: { title: true },
          orderBy: { title: "asc" },
        })
      : [];
    const token = generateToken();
    const messages = renderGuardianRequest({
      guardian: request.guardian,
      buyer: { name: ticket.order.buyerName, email: ticket.order.buyerEmail ?? "" },
      attendee: ticket.attendee,
      event: ticket.event,
      waiverTitles: versions.map((v) => v.title),
      url: `${webBaseUrl}/sign?token=${encodeURIComponent(token)}`,
      texts: Boolean(texter),
      reminder: true,
    });
    if (!messages.email && !messages.text) return false;
    return prisma.$transaction(async (tx) => {
      // Only from the round the sweep found due, so two sweeps can't both queue a reminder.
      const { count } = await tx.guardianSignatureRequest.updateMany({
        where: {
          id: requestId,
          signedAt: null,
          pendingMessages: { equals: Prisma.DbNull },
          remindersSent: round,
        },
        data: {
          pendingMessages: messages as unknown as Prisma.InputJsonValue,
          remindersSent: round + 1,
          emailSentAt: null,
          textSentAt: null,
          sendAttempts: 0,
          sendFirstTriedAt: null,
          // An old attempt's expired claim goes too, or its cleanup could clear this round's messages.
          sendClaimedAt: null,
        },
      });
      if (count === 0) return false;
      await tx.guardianSignatureLink.create({ data: { requestId, tokenHash: hashToken(token) } });
      return true;
    });
  }

  return { send, retry, queueReminder };
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
  /** A follow-up to a guardian who hasn't signed yet. */
  reminder?: boolean;
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
    summary: `${d.reminder ? "Reminded" : "Asked"} to sign ${titles} for ${fullName} (${event.name})`,
  };
  const ask = d.reminder
    ? `${attendee.firstName} still needs a parent or guardian to sign ${titles}`
    : `Because ${attendee.firstName} is under 18, a parent or guardian needs to sign ${titles}`;
  if (guardian.email) {
    const text = [
      `Hi ${guardian.name},`,
      "",
      `${who} got a ticket for ${fullName} to ${event.name} (${event.organization.name}), ${when}.`,
      "",
      `${ask}. Read and sign here:`,
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
      <p style="margin:16px 0">Hi ${escape(guardian.name)}, ${escape(who)} got a ticket for <strong>${escape(fullName)}</strong>. ${escape(ask)}.</p>
      <p style="margin:16px 0"><a href="${escape(d.url)}" style="display:inline-block;padding:12px 20px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px">Read and sign</a></p>
      <p style="margin:16px 0;color:#555;font-size:14px">The link works until the event ends. If you weren't expecting this, you can ignore it.</p>
    </td></tr>
  </table>
</body></html>`;
    messages.email = {
      to: guardian.email,
      subject: `${d.reminder ? "Reminder: please" : "Please"} sign for ${attendee.firstName} to go to ${event.name}`,
      text,
      html,
    };
  }
  if (guardian.phone && d.texts) {
    messages.text = {
      to: guardian.phone,
      body: d.reminder
        ? `${event.organization.name}: reminder, ${fullName}'s ticket to ${event.name} still needs a parent or guardian to sign. Please sign here: ${d.url}`
        : `${event.organization.name}: ${who} got a ticket for ${fullName} to ${event.name}. As their parent or guardian, please sign here: ${d.url}`,
    };
  }
  return messages;
}
