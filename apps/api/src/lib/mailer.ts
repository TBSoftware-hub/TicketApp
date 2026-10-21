import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";

/** An image shown in the HTML body as `<img src="cid:{contentId}">`. */
export interface InlineImage {
  filename: string;
  content: Buffer;
  contentType: string;
  contentId: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  inlineImages?: InlineImage[];
  /** Providers that support it drop a repeat of the same key, so a retried send can't arrive twice. */
  idempotencyKey?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development mailer: writes the message to the log instead of sending it. */
export function createLogMailer(log: FastifyBaseLogger): Mailer {
  return {
    async send(message) {
      const { to, subject, text } = message;
      log.info({ mail: { to, subject, text } }, `Email to ${to}: ${subject}`);
    },
  };
}

/**
 * Sends through any SMTP provider. `url` looks like `smtps://user:pass@smtp.example.com:465`,
 * so switching provider or domain is a configuration change only.
 */
export function createSmtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    // SMTP has no idempotency keys, so a send retried after an unclear failure could repeat.
    async send({ to, subject, text, html, inlineImages }) {
      await transport.sendMail({
        from,
        to,
        subject,
        text,
        html,
        attachments: inlineImages?.map((image) => ({
          filename: image.filename,
          content: image.content,
          contentType: image.contentType,
          cid: image.contentId,
        })),
      });
    },
  };
}

/** Sends through Resend's HTTPS API, which works on hosts that block outbound SMTP ports. */
export function createResendMailer(apiKey: string, from: string, fetchFn = fetch): Mailer {
  return {
    async send({ inlineImages, idempotencyKey, ...message }) {
      const attachments = inlineImages?.map((image) => ({
        filename: image.filename,
        content: image.content.toString("base64"),
        content_type: image.contentType,
        content_id: image.contentId,
      }));
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ from, ...message, ...(attachments ? { attachments } : {}) }),
      });
      if (!res.ok) throw new Error(`Resend rejected the email: ${res.status} ${await res.text()}`);
    },
  };
}

/**
 * Picks a mailer from RESEND_API_KEY or SMTP_URL (with MAIL_FROM); returns none when neither is
 * set, so buildApp falls back to logging.
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  if (!env.RESEND_API_KEY && !env.SMTP_URL) return undefined;
  if (!env.MAIL_FROM) throw new Error("MAIL_FROM must be set when an email provider is configured");
  if (env.RESEND_API_KEY) return createResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  return createSmtpMailer(env.SMTP_URL!, env.MAIL_FROM);
}
