import { z } from "zod";

export const MAX_WAIVER_FIELDS = 30;
export const MAX_WAIVER_CHOICES = 20;

export const waiverFieldTypeSchema = z.enum([
  "TEXT",
  "LONG_TEXT",
  "DATE",
  "EMAIL",
  "PHONE",
  "CHECKBOX",
  "CHOICE",
]);
export type WaiverFieldType = z.infer<typeof waiverFieldTypeSchema>;

export const WAIVER_FIELD_TYPE_LABELS: Record<WaiverFieldType, string> = {
  TEXT: "Short answer",
  LONG_TEXT: "Paragraph",
  DATE: "Date",
  EMAIL: "Email",
  PHONE: "Phone number",
  CHECKBOX: "Checkbox (must be ticked if required)",
  CHOICE: "Pick one",
};

/** One question on a waiver. Signers always give their name and signature as well. */
export const waiverFieldSchema = z
  .object({
    /** Stays the same when the question is edited, so answers line up across versions. */
    id: z.string().regex(/^[a-z0-9]{1,24}$/, "Field IDs are lowercase letters and digits"),
    label: z.string().trim().min(1, "Every question needs a label").max(200),
    type: waiverFieldTypeSchema,
    required: z.boolean(),
    help: z.string().trim().max(300).nullable().optional(),
    options: z.array(z.string().trim().min(1, "Choices can't be blank").max(100)).optional(),
  })
  .transform(({ options, help, ...field }) => ({
    ...field,
    help: help || null,
    // Only a pick-one question has choices.
    ...(field.type === "CHOICE" ? { options: options ?? [] } : {}),
  }))
  .refine(
    (f) =>
      f.type !== "CHOICE" || (f.options!.length >= 2 && f.options!.length <= MAX_WAIVER_CHOICES),
    { message: `A pick-one question needs 2 to ${MAX_WAIVER_CHOICES} choices`, path: ["options"] },
  )
  .refine((f) => f.type !== "CHOICE" || new Set(f.options).size === f.options!.length, {
    message: "A pick-one question can't list the same choice twice",
    path: ["options"],
  });
export type WaiverField = z.infer<typeof waiverFieldSchema>;

export const waiverTemplateSchema = z.object({
  title: z.string().trim().min(2, "Give the waiver a title").max(120),
  body: z.string().trim().min(1, "Write what people are agreeing to").max(20_000),
  requiresGuardianForMinors: z.boolean(),
  fields: z
    .array(waiverFieldSchema)
    .max(MAX_WAIVER_FIELDS, `A waiver can have at most ${MAX_WAIVER_FIELDS} questions`)
    .refine((fields) => new Set(fields.map((f) => f.id)).size === fields.length, {
      message: "Two questions share an ID",
    }),
});
export type WaiverTemplateInput = z.infer<typeof waiverTemplateSchema>;

/** Saving an existing waiver names the version it was edited from, so one edit can't undo another. */
export const updateWaiverTemplateSchema = waiverTemplateSchema.extend({
  version: z.int().min(1),
});

export const archiveWaiverTemplateSchema = z.object({ archived: z.boolean() });
