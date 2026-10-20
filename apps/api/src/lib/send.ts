import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "./errors";
import type { Mailer, MailMessage } from "./mailer";

/**
 * Send an email, turning a provider failure into a clear 502 instead of a generic 500. Runs
 * `onFailure` first so callers can remove the token they just created for the unsent link.
 */
export async function sendOrFail(
  mailer: Mailer,
  message: MailMessage,
  log: FastifyBaseLogger,
  onFailure?: () => Promise<unknown>,
) {
  try {
    await mailer.send(message);
  } catch (err) {
    log.error({ err, to: message.to }, "Email delivery failed");
    await onFailure?.();
    throw new HttpError(
      502,
      `We couldn't send an email to ${message.to}. Check the address and try again.`,
    );
  }
}
