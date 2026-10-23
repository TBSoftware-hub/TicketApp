import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@ticketapp/db";
import type { HealthResponse } from "@ticketapp/shared";
import Fastify, { type FastifyServerOptions } from "fastify";
import { HttpError } from "./lib/errors";
import { cancellationNotices } from "./lib/cancellations";
import { feeReturns } from "./lib/fee-returns";
import { orderConfirmations, type ConfirmOrder } from "./lib/confirmations";
import { guardianRequests } from "./lib/guardian-requests";
import { createLogMailer, type Mailer } from "./lib/mailer";
import type { Payments } from "./lib/payments";
import { createLogTexter, type Texter } from "./lib/texter";
import { attendeeRoutes } from "./routes/attendees";
import { authRoutes } from "./routes/auth";
import { checkoutRoutes } from "./routes/checkout";
import { compRoutes } from "./routes/comps";
import { doorSaleRoutes } from "./routes/door-sales";
import { doorScanRoutes } from "./routes/door-scans";
import { eventRoutes } from "./routes/events";
import { guardianSignatureRoutes } from "./routes/guardian-signatures";
import { memberRoutes } from "./routes/members";
import { orderRoutes } from "./routes/orders";
import { orgRoutes } from "./routes/orgs";
import { paymentRoutes } from "./routes/payments";
import { promoCodeRoutes } from "./routes/promo-codes";
import { publicEventRoutes } from "./routes/public-events";
import { rosterRoutes } from "./routes/roster";
import { ticketChangeRoutes } from "./routes/ticket-changes";
import { ticketTypeRoutes } from "./routes/ticket-types";
import { waiverExportRoutes } from "./routes/waiver-exports";
import { waiverPdfRoutes } from "./routes/waiver-pdfs";
import { waiverRoutes } from "./routes/waivers";

export const API_VERSION = "0.0.0";

export interface AppDeps {
  prisma: PrismaClient;
  mailer?: Mailer;
  /** Sends texts. Left out in production, guardians can only be emailed; elsewhere texts are logged. */
  texter?: Texter;
  /** Connected-account payments; leaving it out switches payments off. */
  payments?: Payments;
  /** Base URL of the web dashboard, used in sign-in links. */
  webBaseUrl?: string;
  /**
   * Server-only secret the door app's sign-in codes are hashed with. Left out in production, code
   * sign-in is switched off; elsewhere a fixed development key is used.
   */
  signInCodeKey?: string;
  /** Sign-in link requests allowed per client IP per minute (default 10). */
  magicLinkPerIpPerMinute?: number;
  /** Checkouts started per client IP per minute (default 30). */
  checkoutPerIpPerMinute?: number;
  /**
   * How often to retry confirmation and cancellation emails that didn't go out, and service fees
   * not yet handed back after a refund; off when left out.
   */
  retryMs?: number;
}

export async function buildApp(deps: AppDeps, options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  if (!deps.mailer && process.env.NODE_ENV === "production") {
    // The log mailer would write working sign-in links to production logs.
    throw new Error("A real mailer must be configured in production");
  }
  const mailer = deps.mailer ?? createLogMailer(app.log);
  const texter =
    deps.texter ?? (process.env.NODE_ENV === "production" ? undefined : createLogTexter(app.log));
  const webBaseUrl = (
    deps.webBaseUrl ??
    process.env.WEB_BASE_URL ??
    "http://localhost:3000"
  ).replace(/\/+$/, "");

  await app.register(cors, {
    // Browsers send origins without a trailing slash, so tolerate one in the setting.
    origin: process.env.WEB_ORIGIN?.split(",").map((o) => o.trim().replace(/\/+$/, "")) ?? true,
  });

  // Limits are opted into per route; in-memory until the API runs on more than one instance.
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      // Upstream failures (Stripe and the like) still need investigating.
      if (error.statusCode >= 500) request.log.error(error.cause ?? error);
      return reply.code(error.statusCode).send({ error: error.message });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.code(statusCode).send({ error: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "Something went wrong" });
  });

  app.get("/health", async (): Promise<HealthResponse> => {
    return { status: "ok", service: "api", version: API_VERSION };
  });

  await app.register(authRoutes, {
    prisma: deps.prisma,
    mailer,
    webBaseUrl,
    signInCodeKey:
      deps.signInCodeKey ??
      process.env.SIGN_IN_CODE_KEY ??
      (process.env.NODE_ENV === "production" ? undefined : "development-sign-in-code-key"),
    magicLinkPerIpPerMinute: deps.magicLinkPerIpPerMinute ?? 10,
  });
  await app.register(orgRoutes, { prisma: deps.prisma });
  await app.register(eventRoutes, { prisma: deps.prisma });
  await app.register(ticketTypeRoutes, { prisma: deps.prisma });
  await app.register(publicEventRoutes, {
    prisma: deps.prisma,
    payments: deps.payments,
    texts: Boolean(texter),
  });
  const confirmations = orderConfirmations({
    prisma: deps.prisma,
    mailer,
    webBaseUrl,
    log: app.log,
  });
  const guardians = guardianRequests({
    prisma: deps.prisma,
    mailer,
    texter,
    log: app.log,
    webBaseUrl,
  });
  // A paid order's tickets go to the buyer, and its minors' signing links to their guardians.
  const confirm: ConfirmOrder = async (orderId, viewKey) => {
    await confirmations.confirm(orderId, viewKey);
    await guardians.send(orderId);
  };
  const notices = cancellationNotices({ prisma: deps.prisma, mailer, log: app.log });
  const fees = feeReturns({ prisma: deps.prisma, payments: deps.payments, log: app.log });
  if (deps.retryMs) {
    const timer = setInterval(() => {
      void confirmations.retry();
      void guardians.retry();
      void notices.retry();
      void fees.retry();
    }, deps.retryMs);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
  await app.register(checkoutRoutes, {
    prisma: deps.prisma,
    payments: deps.payments,
    webBaseUrl,
    checkoutPerIpPerMinute: deps.checkoutPerIpPerMinute ?? 30,
    confirm,
    texts: Boolean(texter),
  });
  await app.register(guardianSignatureRoutes, {
    prisma: deps.prisma,
    signPerIpPerMinute: deps.checkoutPerIpPerMinute ?? 30,
  });
  await app.register(promoCodeRoutes, { prisma: deps.prisma });
  await app.register(waiverRoutes, { prisma: deps.prisma });
  await app.register(waiverPdfRoutes, { prisma: deps.prisma });
  await app.register(waiverExportRoutes, { prisma: deps.prisma });
  await app.register(attendeeRoutes, { prisma: deps.prisma });
  await app.register(rosterRoutes, { prisma: deps.prisma });
  await app.register(compRoutes, { prisma: deps.prisma, payments: deps.payments, confirm });
  await app.register(doorSaleRoutes, { prisma: deps.prisma, payments: deps.payments, confirm });
  await app.register(doorScanRoutes, { prisma: deps.prisma });
  await app.register(orderRoutes, {
    prisma: deps.prisma,
    payments: deps.payments,
    notices,
    fees,
  });
  await app.register(ticketChangeRoutes, { prisma: deps.prisma, mailer, webBaseUrl });
  await app.register(paymentRoutes, { prisma: deps.prisma, payments: deps.payments, webBaseUrl });
  await app.register(memberRoutes, { prisma: deps.prisma, mailer, webBaseUrl });

  return app;
}
