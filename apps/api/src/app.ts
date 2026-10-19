import cors from "@fastify/cors";
import type { HealthResponse } from "@ticketapp/shared";
import Fastify, { type FastifyServerOptions } from "fastify";

export const API_VERSION = "0.0.0";

export async function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  await app.register(cors, {
    origin: process.env.WEB_ORIGIN?.split(",") ?? true,
  });

  app.get("/health", async (): Promise<HealthResponse> => {
    return { status: "ok", service: "api", version: API_VERSION };
  });

  return app;
}
