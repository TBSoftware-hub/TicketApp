import { z } from "zod";

const timestamp = z.union([z.string(), z.date()]).pipe(z.coerce.date());

export const MAX_PRICE_CENTS = 1_000_000;

const ticketTypeFields = z.object({
  name: z.string().trim().min(1, "Give the ticket a name").max(80),
  priceCents: z
    .int("Enter a price in dollars and cents")
    .min(0, "The price can't be negative")
    .max(MAX_PRICE_CENTS, "The price can be at most $10,000"),
  quantity: z.int().min(1, "Offer at least 1 ticket").max(100_000).nullable().optional(),
  maxPerOrder: z.int().min(1, "Allow at least 1 per order").max(50, "Allow at most 50 per order"),
  salesStartAt: timestamp.nullable().optional(),
  salesEndAt: timestamp.nullable().optional(),
});

const salesEndAfterStart = (t: { salesStartAt?: Date | null; salesEndAt?: Date | null }) =>
  !t.salesStartAt || !t.salesEndAt || t.salesEndAt > t.salesStartAt;
const salesEndAfterStartError = {
  message: "Sales have to end after they start",
  path: ["salesEndAt"],
};

export const createTicketTypeSchema = ticketTypeFields.refine(
  salesEndAfterStart,
  salesEndAfterStartError,
);
export type CreateTicketType = z.infer<typeof createTicketTypeSchema>;

export const updateTicketTypeSchema = ticketTypeFields
  .partial()
  .refine(salesEndAfterStart, salesEndAfterStartError);
export type UpdateTicketType = z.infer<typeof updateTicketTypeSchema>;
