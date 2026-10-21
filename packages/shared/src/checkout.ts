import { z } from "zod";
import { MAX_GRADE, MIN_GRADE } from "./ticket-types";

export const feePayerSchema = z.enum(["BUYER", "ORGANIZATION"]);
export type FeePayer = z.infer<typeof feePayerSchema>;

/** Stripe's standard US card pricing: 2.9% (29 per thousand) plus 30¢ per payment. */
export const CARD_FEE_PER_THOUSAND = 29;
export const CARD_FEE_FIXED_CENTS = 30;
/** The smallest card payment Stripe accepts in US dollars. */
export const STRIPE_MINIMUM_CENTS = 50;

export interface OrderTotal {
  /** Added to what the buyer pays; zero when the organization covers the fee. */
  feeCents: number;
  /** What Stripe is expected to keep, recovered from the organization's share. */
  processingFeeCents: number;
  totalCents: number;
}

/**
 * The buyer's total for an order worth `amountCents` after discounts. When the buyer covers the
 * card fee it's grossed up so the organization still receives the full amount.
 */
export function orderTotal(amountCents: number, paidBy: FeePayer): OrderTotal {
  if (amountCents <= 0) return { feeCents: 0, processingFeeCents: 0, totalCents: 0 };
  if (paidBy === "BUYER") {
    // Integer maths so the rounding can't drift a cent.
    const totalCents = Math.ceil(
      ((amountCents + CARD_FEE_FIXED_CENTS) * 1000) / (1000 - CARD_FEE_PER_THOUSAND),
    );
    const feeCents = totalCents - amountCents;
    return { feeCents, processingFeeCents: feeCents, totalCents };
  }
  const fee = Math.round((amountCents * CARD_FEE_PER_THOUSAND) / 1000) + CARD_FEE_FIXED_CENTS;
  return { feeCents: 0, processingFeeCents: Math.min(fee, amountCents), totalCents: amountCents };
}

const name = (label: string) =>
  z.string().trim().min(1, `Enter ${label}`).max(80, `Keep ${label} under 80 characters`);

export const checkoutTicketSchema = z.object({
  ticketTypeId: z.uuid(),
  firstName: name("each attendee's first name"),
  lastName: name("each attendee's last name"),
  grade: z
    .int()
    .min(MIN_GRADE, `Grades go from ${MIN_GRADE} to ${MAX_GRADE}`)
    .max(MAX_GRADE, `Grades go from ${MIN_GRADE} to ${MAX_GRADE}`)
    .nullable()
    .optional(),
});
export type CheckoutTicket = z.infer<typeof checkoutTicketSchema>;

/** One entry in `tickets` per attendee. */
export const checkoutSchema = z.object({
  buyerName: name("your name"),
  // Trim before checking, since people paste addresses with stray spaces.
  buyerEmail: z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email")),
  buyerPhone: z.string().trim().max(30).nullable().optional(),
  promoCode: z
    .string()
    .trim()
    .toUpperCase()
    .max(24)
    .nullable()
    .optional()
    .transform((c) => c || null),
  tickets: z.array(checkoutTicketSchema).min(1, "Pick at least one ticket").max(50),
});
export type Checkout = z.infer<typeof checkoutSchema>;
