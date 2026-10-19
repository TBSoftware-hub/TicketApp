import { describe, expect, it } from "vitest";
import { createOrganizationSchema, magicLinkRequestSchema, roleCan } from "./index";

describe("roleCan", () => {
  it("lets door staff scan but not manage events", () => {
    expect(roleCan("DOOR_STAFF", "checkin.scan")).toBe(true);
    expect(roleCan("DOOR_STAFF", "events.manage")).toBe(false);
  });

  it("reserves organization settings for owners", () => {
    expect(roleCan("OWNER", "org.manage")).toBe(true);
    expect(roleCan("ADMIN", "org.manage")).toBe(false);
  });

  it("gives viewers read-only access", () => {
    expect(roleCan("VIEWER", "reports.view")).toBe(true);
    expect(roleCan("VIEWER", "checkin.scan")).toBe(false);
  });
});

describe("request schemas", () => {
  it("normalises sign-in emails to lowercase", () => {
    expect(magicLinkRequestSchema.parse({ email: "Chair@Example.COM" }).email).toBe(
      "chair@example.com",
    );
  });

  it("rejects slugs that are not URL-safe", () => {
    expect(
      createOrganizationSchema.safeParse({ name: "Lincoln", slug: "Lincoln High!", type: "SCHOOL" })
        .success,
    ).toBe(false);
  });
});
