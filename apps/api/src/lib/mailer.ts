import type { FastifyBaseLogger } from "fastify";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development mailer: writes the message to the log instead of sending it. Replaced by Resend later. */
export function createLogMailer(log: FastifyBaseLogger): Mailer {
  return {
    async send(message) {
      log.info({ mail: message }, `Email to ${message.to}: ${message.subject}`);
    },
  };
}
