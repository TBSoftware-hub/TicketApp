import { z } from "zod";

/** A free ticket staff issue to one person, such as a chaperone or a sponsor. */
export const createCompSchema = z.object({
  ticketTypeId: z.uuid("Pick a ticket type"),
  firstName: z.string().trim().min(1, "Enter a first name").max(80),
  lastName: z.string().trim().min(1, "Enter a last name").max(80),
  email: z.email("Enter a valid email").trim().toLowerCase().max(254),
  note: z.string().trim().max(500).nullable().optional(),
});
export type CreateComp = z.infer<typeof createCompSchema>;
