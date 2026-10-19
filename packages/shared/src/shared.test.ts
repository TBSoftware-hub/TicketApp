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
