import { z } from "zod";

/** Where an attendee's waivers stand, for filtering the attendee list. */
export const attendeeWaiverFilterSchema = z.enum([
  /** Signed, and any guardian has signed too. */
  "signed",
  /** The attendee signed; their parent or guardian hasn't yet. */
  "waiting",
  /** Their ticket asks for waivers and the attendee hasn't signed. */
  "missing",
  /** Their ticket doesn't ask for waivers. */
  "none",
]);
export type AttendeeWaiverFilter = z.infer<typeof attendeeWaiverFilterSchema>;

/** Whether an attendee has come through the door. */
export const attendeeCheckInFilterSchema = z.enum([
  /** Inside the event now. */
  "inside",
  /** Came in and has since been checked out. */
  "left",
  /** Hasn't been let in yet. */
  "not-arrived",
]);
export type AttendeeCheckInFilter = z.infer<typeof attendeeCheckInFilterSchema>;

const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);

/** The dashboard's attendee list: a name search plus filters, all optional. */
export const attendeeSearchSchema = z.object({
  q: z
    .string()
    .trim()
    .max(100, "Keep the search under 100 characters")
    .optional()
    .transform((q) => q || undefined),
  waiver: z.preprocess(blankToUndefined, attendeeWaiverFilterSchema.optional()),
  checkIn: z.preprocess(blankToUndefined, attendeeCheckInFilterSchema.optional()),
  ticketTypeId: z.preprocess(blankToUndefined, z.uuid().optional()),
});
export type AttendeeSearch = z.infer<typeof attendeeSearchSchema>;

/** The attendee download: the list's search and filters, plus whether to add medical details. */
export const attendeeExportSchema = attendeeSearchSchema.extend({
  /** Adds emergency contacts and medical notes, which not everyone the file goes to should see. */
  details: z
    .enum(["1"])
    .optional()
    .transform((d) => d === "1"),
});
export type AttendeeExport = z.infer<typeof attendeeExportSchema>;
