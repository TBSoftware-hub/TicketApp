import type { FastifyBaseLogger } from "fastify";

export interface TextMessage {
  /** In the +15551234567 form. */
  to: string;
  body: string;
}

export interface Texter {
  send(message: TextMessage): Promise<void>;
}

/** Development texter: writes the message to the log instead of sending it. */
export function createLogTexter(log: FastifyBaseLogger): Texter {
  return {
    async send({ to, body }) {
      log.info({ text: { to, body } }, `Text to ${to}`);
    },
  };
}

/**
 * Sends through Twilio's REST API. `from` is a Twilio phone number, or a messaging service ID
 * (starting MG). Twilio has no idempotency keys, so a send retried after an unclear failure could
 * arrive twice.
 */
export function createTwilioTexter(
  { accountSid, authToken, from }: { accountSid: string; authToken: string; from: string },
  fetchFn = fetch,
): Texter {
  return {
    async send({ to, body }) {
      const form = new URLSearchParams({ To: to, Body: body });
      form.set(from.startsWith("MG") ? "MessagingServiceSid" : "From", from);
      const res = await fetchFn(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form,
        },
      );
      if (!res.ok) throw new Error(`Twilio rejected the text: ${res.status} ${await res.text()}`);
    },
  };
}

/** A Twilio texter when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are set. */
export function texterFromEnv(env: NodeJS.ProcessEnv = process.env): Texter | undefined {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = env;
  if (!TWILIO_ACCOUNT_SID && !TWILIO_AUTH_TOKEN && !TWILIO_FROM) return undefined;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
    throw new Error(
      "Set all of TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to send texts",
    );
  }
  return createTwilioTexter({
    accountSid: TWILIO_ACCOUNT_SID,
    authToken: TWILIO_AUTH_TOKEN,
    from: TWILIO_FROM,
  });
}
