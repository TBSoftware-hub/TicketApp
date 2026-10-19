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

/** Picks the SMTP mailer when SMTP_URL is set; otherwise none, so buildApp falls back to logging. */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  if (!env.SMTP_URL) return undefined;
  if (!env.MAIL_FROM) throw new Error("MAIL_FROM must be set when SMTP_URL is set");
  return createSmtpMailer(env.SMTP_URL, env.MAIL_FROM);
}
