import { describe, expect, it } from "vitest";
import {
  createPromoCodeSchema,
  formatCents,
  formatDiscount,
  promoCodeProblem,
  paidTicketCount,
  promoDiscountCents,
} from "./index";

describe("createPromoCodeSchema", () => {
  it("upper-cases the code", () => {
    const parsed = createPromoCodeSchema.parse({
      code: " early-bird ",
      discountType: "PERCENT",
      discountValue: 20,
    });
    expect(parsed.code).toBe("EARLY-BIRD");
  });

  it("rejects bad codes and percentages over 100", () => {
    const base = { discountType: "PERCENT", discountValue: 20 };
    expect(createPromoCodeSchema.safeParse({ ...base, code: "AB" }).success).toBe(false);
    expect(createPromoCodeSchema.safeParse({ ...base, code: "NO SPACES" }).success).toBe(false);
    expect(
      createPromoCodeSchema.safeParse({ ...base, code: "HALF", discountValue: 101 }).success,
    ).toBe(false);
    expect(
      createPromoCodeSchema.safeParse({
        code: "BIG",
        discountType: "AMOUNT",
        discountValue: 5000,
      }).success,
    ).toBe(true);
  });
});

describe("promoDiscountCents", () => {
  const lines = [
    { ticketTypeId: "a", unitCents: 3000, quantity: 2 },
    { ticketTypeId: "b", unitCents: 1999, quantity: 1 },
  ];

  it("takes a percentage off every line, rounding each to the cent", () => {
    expect(
      promoDiscountCents({ discountType: "PERCENT", discountValue: 15, ticketTypeIds: [] }, lines),
    ).toBe(900 + 300); // 15% of 6000 and of 1999 (299.85)
  });

  it("only discounts the ticket types it's limited to", () => {
    expect(
      promoDiscountCents(
        { discountType: "PERCENT", discountValue: 50, ticketTypeIds: ["b"] },
        lines,
      ),
    ).toBe(1000);
  });

  it("takes a fixed amount off once, never more than the eligible tickets cost", () => {
    expect(
      promoDiscountCents({ discountType: "AMOUNT", discountValue: 500, ticketTypeIds: [] }, lines),
    ).toBe(500);
    expect(
      promoDiscountCents(
        { discountType: "AMOUNT", discountValue: 5000, ticketTypeIds: ["b"] },
        lines,
      ),
    ).toBe(1999);
  });
});

describe("promoCodeProblem", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const promo = {
    discountType: "PERCENT" as const,
    discountValue: 10,
    maxUses: 2,
    validFrom: new Date("2026-10-01T00:00:00Z"),
    validUntil: new Date("2026-11-10T00:00:00Z"),
    active: true,
    ticketTypeIds: [],
  };

  it("accepts a live code", () => {
    expect(promoCodeProblem(promo, { uses: 1, now })).toBeNull();
  });

  it("explains why a code can't be used", () => {
    expect(promoCodeProblem({ ...promo, active: false }, { uses: 0, now })).toMatch(/active/);
    expect(promoCodeProblem(promo, { uses: 0, now: new Date("2026-09-01") })).toMatch(/yet/);
    expect(promoCodeProblem(promo, { uses: 0, now: promo.validUntil })).toMatch(/expired/);
    expect(promoCodeProblem(promo, { uses: 2, now })).toMatch(/used up/);
  });

  it("formats discounts", () => {
    expect(formatDiscount(promo, formatCents)).toBe("10% off");
    expect(formatDiscount({ discountType: "AMOUNT", discountValue: 500 }, formatCents)).toBe(
      "$5.00 off",
    );
  });
});

describe("paidTicketCount", () => {
  const lines = [
    { ticketTypeId: "a", unitCents: 1000, quantity: 2 },
    { ticketTypeId: "b", unitCents: 1000, quantity: 1 },
    { ticketTypeId: "free", unitCents: 0, quantity: 3 },
  ];
  const promo = (
    discountType: "PERCENT" | "AMOUNT",
    discountValue: number,
    ticketTypeIds: string[] = [],
  ) => ({
    discountType,
    discountValue,
    ticketTypeIds,
  });

  it("counts every ticket that costs something", () => {
    expect(paidTicketCount(null, lines)).toBe(3);
    expect(paidTicketCount(promo("PERCENT", 50), lines)).toBe(3);
  });

  it("leaves out tickets a code makes free", () => {
    expect(paidTicketCount(promo("PERCENT", 100, ["a"]), lines)).toBe(1);
    expect(paidTicketCount(promo("AMOUNT", 1000, ["b"]), lines)).toBe(2);
    expect(paidTicketCount(promo("PERCENT", 100), lines)).toBe(0);
  });

  it("still counts tickets a set amount only partly covers", () => {
    expect(paidTicketCount(promo("AMOUNT", 1500, ["a"]), lines)).toBe(3);
  });
});
