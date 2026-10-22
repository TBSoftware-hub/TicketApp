import { z } from "zod";
import { checkoutTicketSchema } from "./checkout";

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

const personName = (label: string) =>
  z.string().trim().min(1, `Enter ${label}`).max(80, `Keep ${label} under 80 characters`);

const email = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email"));

/**
 * Staff correcting the details on a ticket, such as a misspelt name. Emergency info is checked
 * against `emergencyInfoSchema` when the ticket type asks for it, and ignored otherwise.
 */
export const editAttendeeSchema = z.object({
  firstName: personName("a first name"),
  lastName: personName("a last name"),
  emergency: z.unknown().optional(),
});
export type EditAttendee = z.infer<typeof editAttendeeSchema>;

/** Staff giving a ticket to someone else. The old QR code stops working. */
export const transferTicketSchema = editAttendeeSchema.extend({
  /** Where to send the new ticket; left out, nobody is emailed. */
  email: z
    .string()
    .trim()
    .max(254)
    .nullable()
    .optional()
    .transform((e) => e || null)
    .pipe(email.nullable()),
  grade: checkoutTicketSchema.shape.grade,
  studentId: checkoutTicketSchema.shape.studentId,
});
export type TransferTicket = z.infer<typeof transferTicketSchema>;

/** Staff sending an order's tickets again, to the buyer's email or a corrected one. */
export const resendOrderSchema = z.object({ email });
export type ResendOrder = z.infer<typeof resendOrderSchema>;
