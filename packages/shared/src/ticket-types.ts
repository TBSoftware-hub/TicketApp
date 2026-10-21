import { z } from "zod";

const timestamp = z.union([z.string(), z.date()]).pipe(z.coerce.date());

export const MAX_PRICE_CENTS = 1_000_000;
export const MIN_GRADE = 1;
export const MAX_GRADE = 12;

const grade = z
  .int()
  .min(MIN_GRADE, `Grades go from ${MIN_GRADE} to ${MAX_GRADE}`)
  .max(MAX_GRADE, `Grades go from ${MIN_GRADE} to ${MAX_GRADE}`);

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
  studentsOnly: z.boolean().optional(),
  minGrade: grade.nullable().optional(),
  maxGrade: grade.nullable().optional(),
  requiresApproval: z.boolean().optional(),
  /** Waivers every attendee with this ticket signs at checkout. */
  waiverIds: z.array(z.uuid()).max(10, "A ticket can ask for at most 10 waivers").optional(),
});

const salesEndAfterStart = (t: { salesStartAt?: Date | null; salesEndAt?: Date | null }) =>
  !t.salesStartAt || !t.salesEndAt || t.salesEndAt > t.salesStartAt;
const salesEndAfterStartError = {
  message: "Sales have to end after they start",
  path: ["salesEndAt"],
};

export interface EligibilityRules {
  studentsOnly: boolean;
  minGrade: number | null;
  maxGrade: number | null;
  requiresApproval: boolean;
}

/** Why a set of eligibility rules doesn't hold together, or null if it does. */
export function eligibilityRulesProblem(r: Partial<EligibilityRules>): string | null {
  if ((r.minGrade != null || r.maxGrade != null) && !r.studentsOnly) {
    return "Grade limits only apply to students-only tickets";
  }
  if (r.minGrade != null && r.maxGrade != null && r.minGrade > r.maxGrade) {
    return "The lowest grade can't be above the highest";
  }
  return null;
}

export const createTicketTypeSchema = ticketTypeFields
  .refine(salesEndAfterStart, salesEndAfterStartError)
  .superRefine((t, ctx) => {
    const problem = eligibilityRulesProblem(t);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["minGrade"] });
  });
export type CreateTicketType = z.infer<typeof createTicketTypeSchema>;

export const updateTicketTypeSchema = ticketTypeFields
  .partial()
  .refine(salesEndAfterStart, salesEndAfterStartError);
export type UpdateTicketType = z.infer<typeof updateTicketTypeSchema>;

/** Who's buying, as checkout knows them. */
export interface Buyer {
  isStudent: boolean;
  grade: number | null;
}

export type Eligibility =
  { eligible: true; needsApproval: boolean } | { eligible: false; reason: string };

/** Whether this buyer may get this ticket type, and whether staff must approve it first. */
export function checkEligibility(rules: EligibilityRules, buyer: Buyer): Eligibility {
  if (rules.studentsOnly) {
    if (!buyer.isStudent) return { eligible: false, reason: "These tickets are for students only" };
    const { minGrade, maxGrade } = rules;
    if (minGrade !== null || maxGrade !== null) {
      if (buyer.grade === null) return { eligible: false, reason: "Enter the student's grade" };
      if (
        (minGrade !== null && buyer.grade < minGrade) ||
        (maxGrade !== null && buyer.grade > maxGrade)
      ) {
        return {
          eligible: false,
          reason: `These tickets are for ${gradeRangeLabel(minGrade, maxGrade)}`,
        };
      }
    }
  }
  return { eligible: true, needsApproval: rules.requiresApproval };
}

const ordinal = (n: number) => {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  return `${n}${suffix}`;
};

/** "grades 9–12", "11th grade", "grades 9 and up". */
export function gradeRangeLabel(minGrade: number | null, maxGrade: number | null): string {
  if (minGrade !== null && maxGrade !== null) {
    return minGrade === maxGrade ? `${ordinal(minGrade)} grade` : `grades ${minGrade}–${maxGrade}`;
  }
  if (minGrade !== null) return `grades ${minGrade} and up`;
  if (maxGrade !== null) return `grades ${maxGrade} and below`;
  return "all grades";
}

export type SaleStatus = "upcoming" | "onSale" | "ended" | "soldOut";

/**
 * Whether a ticket type can be bought right now. `eventRemaining` is what's left of the event's
 * capacity (null when it has none), since a type with tickets left still can't sell past it.
 */
export function ticketSaleStatus(
  tt: { quantity: number | null; salesStartAt: Date | null; salesEndAt: Date | null },
  {
    sold,
    eventEndsAt,
    eventRemaining,
    now = new Date(),
  }: {
    sold: number;
    eventEndsAt: Date;
    eventRemaining: number | null;
    now?: Date;
  },
): SaleStatus {
  if (now >= eventEndsAt || (tt.salesEndAt && now >= tt.salesEndAt)) return "ended";
  if (
    (tt.quantity !== null && sold >= tt.quantity) ||
    (eventRemaining !== null && eventRemaining <= 0)
  ) {
    return "soldOut";
  }
  if (tt.salesStartAt && now < tt.salesStartAt) return "upcoming";
  return "onSale";
}
