import { healthResponseSchema } from "@ticketapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

describe("GET /health", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports the API as healthy", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(healthResponseSchema.parse(res.json()).service).toBe("api");
  });
});
