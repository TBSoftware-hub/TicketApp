import { describe, expect, it } from "vitest";
import { checkoutSchema, orderTotal } from "./index";

describe("orderTotal", () => {
  it("leaves the price alone when the organization covers the fee", () => {
    expect(orderTotal(1000, "ORGANIZATION")).toEqual({
      feeCents: 0,
      processingFeeCents: 59,
      totalCents: 1000,
    });
  });

  it("grosses up the total so the organization still gets the full price", () => {
    for (const amount of [1, 99, 500, 1000, 2500, 123_456]) {
      const { feeCents, totalCents } = orderTotal(amount, "BUYER");
      expect(totalCents).toBe(amount + feeCents);
      // What Stripe keeps from the total leaves at least the ticket price.
      const stripeFee = Math.round((totalCents * 29) / 1000) + 30;
      expect(totalCents - stripeFee).toBeGreaterThanOrEqual(amount);
      expect(totalCents - stripeFee).toBeLessThanOrEqual(amount + 1);
    }
  });

  it("charges nothing on a free order", () => {
    expect(orderTotal(0, "BUYER")).toEqual({ feeCents: 0, processingFeeCents: 0, totalCents: 0 });
  });

  it("never keeps back more than a tiny order is worth", () => {
    expect(orderTotal(20, "ORGANIZATION").processingFeeCents).toBe(20);
  });
});

describe("checkoutSchema", () => {
  it("normalizes the email and promo code", () => {
    const parsed = checkoutSchema.parse({
      buyerName: "Sam Lee",
      buyerEmail: " Sam@Example.com ",
      promoCode: " early ",
      tickets: [
        { ticketTypeId: "0199f1c2-0000-7000-8000-000000000001", firstName: "Sam", lastName: "Lee" },
      ],
    });
    expect(parsed.buyerEmail).toBe("sam@example.com");
    expect(parsed.promoCode).toBe("EARLY");
  });

  it("lower-cases ticket type ids", () => {
    const parsed = checkoutSchema.parse({
      buyerName: "Sam Lee",
      buyerEmail: "sam@example.com",
      tickets: [
        { ticketTypeId: "0199F1C2-0000-7000-8000-00000000000A", firstName: "Sam", lastName: "Lee" },
      ],
    });
    expect(parsed.tickets[0]!.ticketTypeId).toBe("0199f1c2-0000-7000-8000-00000000000a");
  });

  it("treats an empty promo code as none", () => {
    const parsed = checkoutSchema.parse({
      buyerName: "Sam Lee",
      buyerEmail: "sam@example.com",
      promoCode: "",
      tickets: [
        { ticketTypeId: "0199f1c2-0000-7000-8000-000000000001", firstName: "Sam", lastName: "Lee" },
      ],
    });
    expect(parsed.promoCode).toBeNull();
  });
});
