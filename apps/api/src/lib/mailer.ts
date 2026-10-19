import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development mailer: writes the message to the log instead of sending it. */
export function createLogMailer(log: FastifyBaseLogger): Mailer {
  return {
    async send(message) {
      log.info({ mail: message }, `Email to ${message.to}: ${message.subject}`);
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
    async send(message) {
      await transport.sendMail({ from, ...message });
    },
  };
}

/** Sends through Resend's HTTPS API, which works on hosts that block outbound SMTP ports. */
export function createResendMailer(apiKey: string, from: string, fetchFn = fetch): Mailer {
  return {
    async send(message) {
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, ...message }),
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
