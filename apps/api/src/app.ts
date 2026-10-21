import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@ticketapp/db";
import type { HealthResponse } from "@ticketapp/shared";
import Fastify, { type FastifyServerOptions } from "fastify";
import { HttpError } from "./lib/errors";
import { createLogMailer, type Mailer } from "./lib/mailer";
import type { Payments } from "./lib/payments";
import { authRoutes } from "./routes/auth";
import { checkoutRoutes } from "./routes/checkout";
import { compRoutes } from "./routes/comps";
import { eventRoutes } from "./routes/events";
import { memberRoutes } from "./routes/members";
import { orgRoutes } from "./routes/orgs";
import { paymentRoutes } from "./routes/payments";
import { promoCodeRoutes } from "./routes/promo-codes";
import { publicEventRoutes } from "./routes/public-events";
import { ticketTypeRoutes } from "./routes/ticket-types";

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
  await app.register(checkoutRoutes, {
    prisma: deps.prisma,
    payments: deps.payments,
    webBaseUrl,
    checkoutPerIpPerMinute: deps.checkoutPerIpPerMinute ?? 30,
  });
  await app.register(promoCodeRoutes, { prisma: deps.prisma });
  await app.register(compRoutes, { prisma: deps.prisma, payments: deps.payments });
  await app.register(paymentRoutes, { prisma: deps.prisma, payments: deps.payments, webBaseUrl });
  await app.register(memberRoutes, { prisma: deps.prisma, mailer, webBaseUrl });

  return app;
}
