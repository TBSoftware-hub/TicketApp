import { z } from "zod";

/** The dashboard's order search: matches buyer and attendee names and the buyer's email. */
export const orderSearchSchema = z.object({
  q: z
    .string()
    .trim()
    .max(100, "Keep the search under 100 characters")
    .optional()
    .transform((q) => q || undefined),
  /** Only orders with a ticket still waiting on a guardian's signature. */
  waiting: z
    .enum(["1"])
    .optional()
    .transform((w) => w === "1"),
});
