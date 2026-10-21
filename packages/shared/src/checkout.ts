import { z } from "zod";
import { MAX_GRADE, MIN_GRADE } from "./ticket-types";

export const feePayerSchema = z.enum(["BUYER", "ORGANIZATION"]);
export type FeePayer = z.infer<typeof feePayerSchema>;

/** Stripe's standard US card pricing: 2.9% (29 per thousand) plus 30¢ per payment. */
export const CARD_FEE_PER_THOUSAND = 29;
export const CARD_FEE_FIXED_CENTS = 30;
/** The smallest card payment Stripe accepts in US dollars. */
export const STRIPE_MINIMUM_CENTS = 50;

/** The platform's fee on each paid ticket. Free and comp tickets carry none. */
export const SERVICE_FEE_CENTS = 75;

/** Who covers each fee, as the organization has chosen. */
export interface FeeSettings {
  cardFeePaidBy: FeePayer;
  serviceFeePaidBy: FeePayer;
}

export interface OrderTotal {
  /** Card fee added to what the buyer pays; zero when the organization covers it. */
  feeCents: number;
  /** Service fee added to what the buyer pays; zero when the organization covers it. */
  serviceFeeCents: number;
  /** What Stripe is expected to keep, recovered from the organization's share. */
  processingFeeCents: number;
  /** The service fee the platform keeps, whoever pays it. */
  platformFeeCents: number;
  totalCents: number;
}

/**
 * The buyer's total for an order worth `amountCents` after discounts, with `paidTickets` tickets
 * that cost something. Fees the buyer covers are added to the total; when the buyer covers the
 * card fee it's grossed up so the organization still receives the full amount.
 */
export function orderTotal(
  amountCents: number,
  paidTickets: number,
  { cardFeePaidBy, serviceFeePaidBy }: FeeSettings,
): OrderTotal {
  if (amountCents <= 0) {
    return {
      feeCents: 0,
      serviceFeeCents: 0,
      processingFeeCents: 0,
      platformFeeCents: 0,
      totalCents: 0,
    };
  }
  const serviceFee = paidTickets * SERVICE_FEE_CENTS;
  const serviceFeeCents = serviceFeePaidBy === "BUYER" ? serviceFee : 0;
  // Stripe's fee is charged on everything the buyer pays, service fee included.
  const baseCents = amountCents + serviceFeeCents;
  let feeCents = 0;
  let totalCents = baseCents;
  let processingFeeCents: number;
  if (cardFeePaidBy === "BUYER") {
    // Integer maths so the rounding can't drift a cent.
    totalCents = Math.ceil(
      ((baseCents + CARD_FEE_FIXED_CENTS) * 1000) / (1000 - CARD_FEE_PER_THOUSAND),
    );
    feeCents = totalCents - baseCents;
    processingFeeCents = feeCents;
  } else {
    const fee = Math.round((baseCents * CARD_FEE_PER_THOUSAND) / 1000) + CARD_FEE_FIXED_CENTS;
    processingFeeCents = Math.min(fee, baseCents);
  }
  // Never keeps back more than the payment, so a tiny order the organization covers still works.
  const platformFeeCents = Math.min(serviceFee, totalCents - processingFeeCents);
  return { feeCents, serviceFeeCents, processingFeeCents, platformFeeCents, totalCents };
}

const name = (label: string) =>
  z.string().trim().min(1, `Enter ${label}`).max(80, `Keep ${label} under 80 characters`);

export const checkoutTicketSchema = z.object({
  // Lower-cased to match the ids Postgres hands back, which checkout looks tickets up by.
  ticketTypeId: z.string().trim().toLowerCase().pipe(z.uuid()),
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
