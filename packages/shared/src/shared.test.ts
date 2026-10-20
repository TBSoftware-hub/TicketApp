import { describe, expect, it } from "vitest";
import { formatCents, healthResponseSchema, isAdmittingOutcome } from "./index";

describe("formatCents", () => {
  it("formats integer cents as dollars", () => {
    expect(formatCents(2500)).toBe("$25.00");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("rejects fractional cents", () => {
    expect(() => formatCents(10.5)).toThrow(RangeError);
  });
});

describe("isAdmittingOutcome", () => {
  it("only lets admitted and checked-out scans through", () => {
    expect(isAdmittingOutcome("admitted")).toBe(true);
    expect(isAdmittingOutcome("checked_out")).toBe(true);
    expect(isAdmittingOutcome("waiver_missing")).toBe(false);
  });
});

describe("healthResponseSchema", () => {
  it("accepts a healthy response", () => {
    expect(healthResponseSchema.parse({ status: "ok", service: "api", version: "0.0.0" })).toEqual({
      status: "ok",
      service: "api",
      version: "0.0.0",
    });
  });
});

describe("event and organization validation", () => {
  it("rejects null or boolean event times instead of coercing them to 1970", async () => {
    const { createEventSchema, updateEventSchema } = await import("./events");
    const base = {
      name: "Homecoming",
      slug: "homecoming",
      startsAt: "2026-11-15T00:00:00.000Z",
      endsAt: "2026-11-15T03:00:00.000Z",
    };
    expect(createEventSchema.safeParse(base).success).toBe(true);
    expect(createEventSchema.safeParse({ ...base, startsAt: null }).success).toBe(false);
    expect(updateEventSchema.safeParse({ startsAt: false }).success).toBe(false);
    expect(updateEventSchema.safeParse({ startsAt: new Date() }).success).toBe(true);
  });

  it("only accepts real time zones", async () => {
    const { createOrganizationSchema } = await import("./orgs");
    const org = { name: "Test High", slug: "test-high", type: "SCHOOL" };
    expect(
      createOrganizationSchema.safeParse({ ...org, timezone: "America/New_York" }).success,
    ).toBe(true);
    expect(
      createOrganizationSchema.safeParse({ ...org, timezone: "America/NewYork" }).success,
    ).toBe(false);
  });
});
