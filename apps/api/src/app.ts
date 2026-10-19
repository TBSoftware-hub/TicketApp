import cors from "@fastify/cors";
import type { PrismaClient } from "@ticketapp/db";
import type { HealthResponse } from "@ticketapp/shared";
import Fastify, { type FastifyServerOptions } from "fastify";
import { HttpError } from "./lib/errors";
import { createLogMailer, type Mailer } from "./lib/mailer";
import { authRoutes } from "./routes/auth";
import { orgRoutes } from "./routes/orgs";

export const API_VERSION = "0.0.0";

export interface AppDeps {
  prisma: PrismaClient;
  mailer?: Mailer;
  /** Base URL of the web dashboard, used in sign-in links. */
  webBaseUrl?: string;
}

export async function buildApp(deps: AppDeps, options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  const mailer = deps.mailer ?? createLogMailer(app.log);
  const webBaseUrl = deps.webBaseUrl ?? process.env.WEB_BASE_URL ?? "http://localhost:3000";

  await app.register(cors, {
    origin: process.env.WEB_ORIGIN?.split(",") ?? true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
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

  await app.register(authRoutes, { prisma: deps.prisma, mailer, webBaseUrl });
  await app.register(orgRoutes, { prisma: deps.prisma });

  return app;
}
