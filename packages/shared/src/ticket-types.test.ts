import { describe, expect, it } from "vitest";
import { createTicketTypeSchema, parseDollarsToCents, updateTicketTypeSchema } from "./index";

describe("parseDollarsToCents", () => {
  it.each([
    ["12", 1200],
    ["12.5", 1250],
    ["12.05", 1205],
    ["$1,012.50", 101250],
    ["0", 0],
    [" 7.00 ", 700],
  ])("reads %j as %i cents", (input, cents) => {
    expect(parseDollarsToCents(input)).toBe(cents);
  });

  it.each(["", "abc", "12.345", "-5", "12,50", "1.2.3", "$"])("rejects %j", (input) => {
    expect(parseDollarsToCents(input)).toBeNull();
  });
});

describe("ticket type schemas", () => {
  const base = { name: "General", priceCents: 1500, maxPerOrder: 10 };

  it("accepts a free ticket with no limit or sale window", () => {
    expect(createTicketTypeSchema.safeParse({ ...base, priceCents: 0 }).success).toBe(true);
  });

  it("rejects fractional cents and negative prices", () => {
    expect(createTicketTypeSchema.safeParse({ ...base, priceCents: 12.5 }).success).toBe(false);
    expect(createTicketTypeSchema.safeParse({ ...base, priceCents: -1 }).success).toBe(false);
  });

  it("requires sales to end after they start", () => {
    const window = { salesStartAt: "2026-11-01T00:00:00Z", salesEndAt: "2026-10-01T00:00:00Z" };
    expect(createTicketTypeSchema.safeParse({ ...base, ...window }).success).toBe(false);
    expect(updateTicketTypeSchema.safeParse(window).success).toBe(false);
  });
});
