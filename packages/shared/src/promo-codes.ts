import { z } from "zod";

const timestamp = z.union([z.string(), z.date()]).pipe(z.coerce.date());

export const discountTypeSchema = z.enum(["PERCENT", "AMOUNT"]);
export type DiscountType = z.infer<typeof discountTypeSchema>;

/** Buyers type codes in any case; they're stored and compared upper-case. */
export const promoCodeString = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{3,24}$/, "Use 3 to 24 letters, numbers or hyphens");

export const createPromoCodeSchema = z
  .object({
    code: promoCodeString,
    discountType: discountTypeSchema,
    discountValue: z.int().min(1, "Enter a discount above zero").max(1_000_000),
    maxUses: z.int().min(1).max(100_000).nullable().optional(),
    validFrom: timestamp.nullable().optional(),
    validUntil: timestamp.nullable().optional(),
    ticketTypeIds: z.array(z.uuid()).max(50).optional(),
  })
  .refine((p) => p.discountType !== "PERCENT" || p.discountValue <= 100, {
    message: "A percentage can be at most 100",
    path: ["discountValue"],
  })
  .refine((p) => !p.validFrom || !p.validUntil || p.validUntil > p.validFrom, {
    message: "The code has to stop working after it starts",
    path: ["validUntil"],
  });
export type CreatePromoCode = z.infer<typeof createPromoCodeSchema>;

export const updatePromoCodeSchema = z.object({ active: z.boolean() });

export interface PromoRules {
  discountType: DiscountType;
  discountValue: number;
  maxUses: number | null;
  validFrom: Date | null;
  validUntil: Date | null;
  active: boolean;
  /** Empty means every ticket type. */
  ticketTypeIds: string[];
}

/** Why a code can't be used right now, or null if it can. */
export function promoCodeProblem(
  promo: PromoRules,
  { uses, now = new Date() }: { uses: number; now?: Date },
): string | null {
  if (!promo.active) return "That code isn't active";
  if (promo.validFrom && now < promo.validFrom) return "That code isn't valid yet";
  if (promo.validUntil && now >= promo.validUntil) return "That code has expired";
  if (promo.maxUses !== null && uses >= promo.maxUses) return "That code has been used up";
  return null;
}

export interface OrderLine {
  ticketTypeId: string;
  unitCents: number;
  quantity: number;
}

/**
 * Cents off an order. Percentages apply to each eligible line, rounded to the nearest cent;
 * a fixed amount comes off the order once. Never more than the eligible lines cost.
 */
export function promoDiscountCents(
  promo: Pick<PromoRules, "discountType" | "discountValue" | "ticketTypeIds">,
  lines: OrderLine[],
): number {
  const eligible = lines.filter(
    (l) => promo.ticketTypeIds.length === 0 || promo.ticketTypeIds.includes(l.ticketTypeId),
  );
  const eligibleCents = eligible.reduce((sum, l) => sum + l.unitCents * l.quantity, 0);
  const discount =
    promo.discountType === "PERCENT"
      ? eligible.reduce(
          (sum, l) => sum + Math.round((l.unitCents * l.quantity * promo.discountValue) / 100),
          0,
        )
      : promo.discountValue;
  return Math.min(discount, eligibleCents);
}

/**
 * How many tickets in an order cost the buyer something, so carry the service fee. Tickets that
 * are free, or that a code makes free, don't count. A code taking a set amount off only frees the
 * tickets it applies to when it covers all of them, since it can't be pinned to one ticket.
 */
export function paidTicketCount(
  promo: Pick<PromoRules, "discountType" | "discountValue" | "ticketTypeIds"> | null,
  lines: OrderLine[],
): number {
  const applies = (l: OrderLine) =>
    !!promo && (promo.ticketTypeIds.length === 0 || promo.ticketTypeIds.includes(l.ticketTypeId));
  const eligibleCents = lines.filter(applies).reduce((sum, l) => sum + l.unitCents * l.quantity, 0);
  // Rounded as promoDiscountCents rounds it, so a line it discounts to nothing counts as free.
  const free = (l: OrderLine) =>
    applies(l) &&
    (promo!.discountType === "PERCENT"
      ? Math.round((l.unitCents * l.quantity * promo!.discountValue) / 100) >=
        l.unitCents * l.quantity
      : promo!.discountValue >= eligibleCents);
  return lines.reduce((n, l) => n + (l.unitCents > 0 && !free(l) ? l.quantity : 0), 0);
}

/** "20% off", "$5.00 off". */
export function formatDiscount(
  promo: Pick<PromoRules, "discountType" | "discountValue">,
  formatCents: (cents: number) => string,
): string {
  return promo.discountType === "PERCENT"
    ? `${promo.discountValue}% off`
    : `${formatCents(promo.discountValue)} off`;
}
