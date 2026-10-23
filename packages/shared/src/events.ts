import { z } from "zod";

export const eventStatusSchema = z.enum(["DRAFT", "PUBLISHED", "CANCELLED"]);
export type EventStatus = z.infer<typeof eventStatusSchema>;

// Coercion alone would turn null or false into 1970; only accept ISO strings and Dates.
const timestamp = z.union([z.string(), z.date()]).pipe(z.coerce.date());

const eventFields = z.object({
  name: z.string().trim().min(2, "Give the event a name").max(120),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens"),
  description: z.string().trim().max(5000).nullable().optional(),
  venue: z.string().trim().max(200).nullable().optional(),
  startsAt: timestamp,
  endsAt: timestamp,
  capacity: z.int().min(1).max(100_000).nullable().optional(),
  /** Whether someone who checks out at the door may come back in. */
  reentryAllowed: z.boolean().optional(),
});

const endsAfterStart = (e: { startsAt?: Date; endsAt?: Date }) =>
  !e.startsAt || !e.endsAt || e.endsAt > e.startsAt;
const endsAfterStartError = { message: "The event has to end after it starts", path: ["endsAt"] };

export const createEventSchema = eventFields.refine(endsAfterStart, endsAfterStartError);
export type CreateEvent = z.infer<typeof createEventSchema>;

export const updateEventSchema = eventFields.partial().refine(endsAfterStart, endsAfterStartError);
export type UpdateEvent = z.infer<typeof updateEventSchema>;
