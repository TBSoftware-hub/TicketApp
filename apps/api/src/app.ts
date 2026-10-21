import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@ticketapp/db";
import type { HealthResponse } from "@ticketapp/shared";
import Fastify, { type FastifyServerOptions } from "fastify";
import { HttpError } from "./lib/errors";
import { cancellationNotices } from "./lib/cancellations";
import { feeReturns } from "./lib/fee-returns";
import { orderConfirmations } from "./lib/confirmations";
import { createLogMailer, type Mailer } from "./lib/mailer";
import type { Payments } from "./lib/payments";
import { authRoutes } from "./routes/auth";
import { checkoutRoutes } from "./routes/checkout";
import { compRoutes } from "./routes/comps";
import { doorSaleRoutes } from "./routes/door-sales";
import { eventRoutes } from "./routes/events";
import { memberRoutes } from "./routes/members";
import { orderRoutes } from "./routes/orders";
import { orgRoutes } from "./routes/orgs";
import { paymentRoutes } from "./routes/payments";
import { promoCodeRoutes } from "./routes/promo-codes";
import { publicEventRoutes } from "./routes/public-events";
import { ticketTypeRoutes } from "./routes/ticket-types";
import { waiverRoutes } from "./routes/waivers";

export const API_VERSION = "0.0.0";

export interface AppDeps {
  prisma: PrismaClient;
  mailer?: Mailer;
  /** Connected-account payments; leaving it out switches payments off. */
  payments?: Payments;
  /** Base URL of the web dashboard, used in sign-in links. */
  webBaseUrl?: string;
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
    magicLinkPerIpPerMinute: deps.magicLinkPerIpPerMinute ?? 10,
  });
  await app.register(orgRoutes, { prisma: deps.prisma });
  await app.register(eventRoutes, { prisma: deps.prisma });
  await app.register(ticketTypeRoutes, { prisma: deps.prisma });
  await app.register(publicEventRoutes, { prisma: deps.prisma, payments: deps.payments });
  const confirmations = orderConfirmations({
    prisma: deps.prisma,
    mailer,
    webBaseUrl,
    log: app.log,
  });
  const confirm = confirmations.confirm;
  const notices = cancellationNotices({ prisma: deps.prisma, mailer, log: app.log });
  const fees = feeReturns({ prisma: deps.prisma, payments: deps.payments, log: app.log });
  if (deps.retryMs) {
    const timer = setInterval(() => {
      void confirmations.retry();
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
  });
  await app.register(promoCodeRoutes, { prisma: deps.prisma });
  await app.register(waiverRoutes, { prisma: deps.prisma });
  await app.register(compRoutes, { prisma: deps.prisma, payments: deps.payments, confirm });
  await app.register(doorSaleRoutes, { prisma: deps.prisma, payments: deps.payments, confirm });
  await app.register(orderRoutes, {
    prisma: deps.prisma,
    payments: deps.payments,
    notices,
    fees,
  });
  await app.register(paymentRoutes, { prisma: deps.prisma, payments: deps.payments, webBaseUrl });
  await app.register(memberRoutes, { prisma: deps.prisma, mailer, webBaseUrl });

  return app;
}
