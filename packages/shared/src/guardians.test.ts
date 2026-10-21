import { describe, expect, it } from "vitest";
import {
  ageOn,
  birthDateSchema,
  guardianContactSchema,
  isMinorAt,
  localDate,
  normalizePhone,
} from "./guardians";

describe("ages", () => {
  it("counts whole years, turning over on the birthday", () => {
    expect(ageOn("2009-05-01", "2027-04-30")).toBe(17);
    expect(ageOn("2009-05-01", "2027-05-01")).toBe(18);
    expect(ageOn("2008-02-29", "2026-02-28")).toBe(17);
    expect(ageOn("2008-02-29", "2026-03-01")).toBe(18);
  });

  it("judges age on the event's own date, in its time zone", () => {
    // 2am UTC on May 1 is still April 30 in Los Angeles.
    const startsAt = "2027-05-01T02:00:00.000Z";
    expect(localDate(startsAt, "America/Los_Angeles")).toBe("2027-04-30");
    expect(isMinorAt("2009-05-01", startsAt, "America/Los_Angeles")).toBe(true);
    expect(isMinorAt("2009-05-01", startsAt, "UTC")).toBe(false);
  });

  it("takes only real dates of birth in the past", () => {
    expect(birthDateSchema.safeParse("2010-06-15").success).toBe(true);
    expect(birthDateSchema.safeParse("2010-02-30").success).toBe(false);
    expect(birthDateSchema.safeParse("1850-01-01").success).toBe(false);
    expect(birthDateSchema.safeParse("2999-01-01").success).toBe(false);
  });
});

describe("guardian contacts", () => {
  it("normalizes phone numbers", () => {
    expect(normalizePhone("(555) 201-3344")).toBe("+15552013344");
    expect(normalizePhone("1 555 201 3344")).toBe("+15552013344");
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("555-0100")).toBeNull();
    expect(normalizePhone("(055) 201-3344")).toBeNull();
  });

  it("needs a name and an email or mobile number", () => {
    const parse = (input: object) => guardianContactSchema.safeParse(input);
    expect(parse({ name: "Pat Park", email: " Pat@Example.com " }).data).toEqual({
      name: "Pat Park",
      email: "pat@example.com",
    });
    expect(parse({ name: "Pat Park", email: "", phone: "555 201 3344" }).data).toEqual({
      name: "Pat Park",
      email: null,
      phone: "+15552013344",
    });
    expect(parse({ name: "Pat Park", email: "", phone: "" }).error?.issues[0]?.message).toBe(
      "Give the parent or guardian's email or mobile number",
    );
    expect(parse({ name: "Pat Park", phone: "12" }).error?.issues[0]?.message).toBe(
      "Enter a valid mobile number for the parent or guardian",
    );
  });
});
