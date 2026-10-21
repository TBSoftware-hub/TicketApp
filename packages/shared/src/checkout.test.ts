import { describe, expect, it } from "vitest";
import { checkoutSchema, orderTotal, SERVICE_FEE_CENTS } from "./index";

describe("orderTotal", () => {
  const org = { cardFeePaidBy: "ORGANIZATION", serviceFeePaidBy: "ORGANIZATION" } as const;
  const buyer = { cardFeePaidBy: "BUYER", serviceFeePaidBy: "BUYER" } as const;

  it("leaves the price alone when the organization covers both fees", () => {
    expect(orderTotal(1000, 1, org)).toEqual({
      feeCents: 0,
      serviceFeeCents: 0,
      processingFeeCents: 59,
      platformFeeCents: SERVICE_FEE_CENTS,
      totalCents: 1000,
    });
  });

  it("adds the service fee for each paid ticket when the buyer covers it", () => {
    expect(orderTotal(2000, 2, { ...org, serviceFeePaidBy: "BUYER" })).toEqual({
      feeCents: 0,
      serviceFeeCents: 150,
      // Stripe takes its share of the service fee too.
      processingFeeCents: 92,
      platformFeeCents: 150,
      totalCents: 2150,
    });
  });

  it("grosses up the total so the organization still gets the full price", () => {
    for (const amount of [1, 99, 500, 1000, 2500, 123_456]) {
      for (const tickets of [1, 3]) {
        const t = orderTotal(amount, tickets, buyer);
        expect(t.totalCents).toBe(amount + t.serviceFeeCents + t.feeCents);
        expect(t.serviceFeeCents).toBe(tickets * SERVICE_FEE_CENTS);
        // After Stripe and the platform take their share, the ticket price is left.
        const stripeFee = Math.round((t.totalCents * 29) / 1000) + 30;
        const left = t.totalCents - stripeFee - t.platformFeeCents;
        expect(left).toBeGreaterThanOrEqual(amount);
        expect(left).toBeLessThanOrEqual(amount + 1);
      }
    }
  });

  it("charges nothing on a free order", () => {
    expect(orderTotal(0, 0, buyer)).toEqual({
      feeCents: 0,
      serviceFeeCents: 0,
      processingFeeCents: 0,
      platformFeeCents: 0,
      totalCents: 0,
    });
  });

  it("never keeps back more than a tiny order is worth", () => {
    const t = orderTotal(60, 1, org);
    expect(t.processingFeeCents).toBe(32);
    expect(t.processingFeeCents + t.platformFeeCents).toBe(60);
    expect(orderTotal(20, 1, org)).toMatchObject({ processingFeeCents: 20, platformFeeCents: 0 });
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
