import { healthResponseSchema } from "@ticketapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "./test-helpers";

describe("GET /health", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it("reports the API as healthy", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(healthResponseSchema.parse(res.json()).service).toBe("api");
  });

  it("rejects malformed organization ids", async () => {
    const res = await t.app.inject({ method: "GET", url: "/orgs/not-a-uuid" });
    expect(res.statusCode).toBe(400);
  });
});
