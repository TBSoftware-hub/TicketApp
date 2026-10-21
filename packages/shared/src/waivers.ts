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

/** What a signer gives for one question: text for most, true or false for a checkbox. */
export type WaiverAnswer = string | boolean;

const ANSWER_LIMITS: Record<WaiverFieldType, number> = {
  TEXT: 500,
  LONG_TEXT: 5000,
  DATE: 10,
  EMAIL: 254,
  PHONE: 30,
  CHECKBOX: 0,
  CHOICE: 100,
};

/**
 * Checks a signer's answers against a waiver's questions. Returns the answers to store, trimmed
 * and limited to the waiver's own questions, or the first problem, which names the question.
 */
export function checkWaiverAnswers(
  fields: readonly WaiverField[],
  answers: Record<string, unknown>,
): { answers: Record<string, WaiverAnswer> } | { problem: string } {
  const kept: Record<string, WaiverAnswer> = {};
  for (const field of fields) {
    const raw = answers[field.id];
    if (field.type === "CHECKBOX") {
      const ticked = raw === true;
      if (field.required && !ticked) return { problem: `Tick “${field.label}”` };
      kept[field.id] = ticked;
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      if (field.required) return { problem: `Answer “${field.label}”` };
      continue;
    }
    if (value.length > ANSWER_LIMITS[field.type]) {
      return { problem: `Keep “${field.label}” under ${ANSWER_LIMITS[field.type]} characters` };
    }
    if (field.type === "DATE" && !z.iso.date().safeParse(value).success) {
      return { problem: `Enter a date for “${field.label}”` };
    }
    if (field.type === "EMAIL" && !z.email().safeParse(value).success) {
      return { problem: `Enter a valid email for “${field.label}”` };
    }
    if (field.type === "CHOICE" && !field.options?.includes(value)) {
      return { problem: `Pick one of the choices for “${field.label}”` };
    }
    kept[field.id] = value;
  }
  return { answers: kept };
}

/** Whether a typed signature is the signer's name, ignoring case and extra spaces. */
export function signatureMatches(signature: string, name: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(signature) !== "" && norm(signature) === norm(name);
}

/** One waiver signed at checkout for one attendee. */
export const checkoutWaiverSchema = z.object({
  waiverId: z.string().trim().toLowerCase().pipe(z.uuid()),
  /** The version the signer read, so a waiver reworded meanwhile isn't signed unseen. */
  version: z.int().min(1),
  answers: z.record(z.string(), z.union([z.string().max(5000), z.boolean()])).default({}),
  signature: z.string().trim().max(170),
  agreed: z.literal(true, "Agree to each waiver to continue"),
});
export type CheckoutWaiver = z.infer<typeof checkoutWaiverSchema>;
