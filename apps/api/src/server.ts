import { createPrismaClient } from "@ticketapp/db";
import { buildApp } from "./app";
import { mailerFromEnv } from "./lib/mailer";
import { paymentsFromEnv } from "./lib/payments";

const port = Number(process.env.PORT ?? 4000);
const trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
const host = process.env.HOST ?? "0.0.0.0";

const prisma = createPrismaClient();
const app = await buildApp(
  {
    prisma,
    mailer: mailerFromEnv(),
    payments: paymentsFromEnv(),
    // Catches confirmation emails that failed, for buyers who don't come back to their order.
    emailRetryMs: 5 * 60_000,
  },
  // Number of proxy hops in front of the API. Trusting only those hops means a client can't pick
  // its own IP (and dodge rate limits) by sending a forged X-Forwarded-For.
  { logger: true, trustProxy: (_address, hop) => hop < trustedProxyHops },
);
app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
