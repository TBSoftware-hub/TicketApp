import { z } from "zod";

/** Attendees younger than this on the day of the event need a parent or guardian to sign. */
export const ADULT_AGE = 18;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date ("2027-05-01") of `instant` in `timeZone`. */
export function localDate(instant: Date | string, timeZone: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** Whole years from `birthDate` to `onDate`, both "YYYY-MM-DD". */
export function ageOn(birthDate: string, onDate: string): number {
  const [, by, bm, bd] = DATE_PATTERN.exec(birthDate)!.map(Number) as number[];
  const [, y, m, d] = DATE_PATTERN.exec(onDate)!.map(Number) as number[];
  const hadBirthday = m! > bm! || (m === bm && d! >= bd!);
  return y! - by! - (hadBirthday ? 0 : 1);
}

/** Whether someone born on `birthDate` is under 18 on the day the event starts, where it happens. */
export function isMinorAt(birthDate: string, startsAt: Date | string, timeZone: string): boolean {
  return ageOn(birthDate, localDate(startsAt, timeZone)) < ADULT_AGE;
}

/**
 * A phone number in the +15551234567 form texting providers take, or null if it can't be one.
 * Ten digits are taken as a US number.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (input.trim().startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 && digits[0] !== "0" ? `+${digits}` : null;
  }
  if (digits.length === 10 && !/^[01]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && !/^[01]/.test(digits.slice(1))) {
    return `+${digits}`;
  }
  return null;
}

/** A stored number as people write it: "(555) 201-3344" for US numbers, as stored otherwise. */
export function formatPhone(phone: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone;
}

/** A date of birth: a real calendar date, in the past, within a lifetime. */
export const birthDateSchema = z
  .string()
  .trim()
  .pipe(z.iso.date("Enter a date of birth"))
  .refine((d) => d >= "1900-01-01" && d <= new Date().toISOString().slice(0, 10), {
    message: "Enter a date of birth in the past",
  });

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), schema.nullish());

/** Who to ask for a minor's guardian signature. At least one way to reach them is needed. */
export const guardianContactSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Enter the parent or guardian's name")
      .max(80, "Keep the parent or guardian's name under 80 characters"),
    email: optional(
      z
        .string()
        .trim()
        .toLowerCase()
        .max(254)
        .pipe(z.email("Enter a valid email for the parent or guardian")),
    ),
    phone: optional(
      z
        .string()
        .max(30)
        .transform((p, ctx) => {
          const phone = normalizePhone(p);
          if (!phone) {
            ctx.addIssue({
              code: "custom",
              message: "Enter a valid mobile number for the parent or guardian",
            });
            return z.NEVER;
          }
          return phone;
        }),
    ),
  })
  .refine((g) => g.email || g.phone, {
    message: "Give the parent or guardian's email or mobile number",
  });
export type GuardianContact = z.infer<typeof guardianContactSchema>;

export const MAX_MEDICAL_NOTES = 2000;

/** Who to call in an emergency, and anything staff should know, for one attendee. */
export const emergencyInfoSchema = z.object({
  contactName: z
    .string()
    .trim()
    .min(1, "Enter the emergency contact's name")
    .max(80, "Keep the emergency contact's name under 80 characters"),
  contactPhone: z
    .string()
    .max(30)
    .transform((p, ctx) => {
      const phone = normalizePhone(p);
      if (!phone) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid phone number for the emergency contact",
        });
        return z.NEVER;
      }
      return phone;
    }),
  medicalNotes: optional(
    z
      .string()
      .trim()
      .max(MAX_MEDICAL_NOTES, `Keep medical notes under ${MAX_MEDICAL_NOTES} characters`),
  ),
});
export type EmergencyInfo = z.infer<typeof emergencyInfoSchema>;

/** What a guardian sends to sign every waiver waiting on them for one attendee. */
export const guardianSignSchema = z.object({
  token: z.string().min(1).max(100),
  signature: z
    .string()
    .trim()
    .min(2, "Type your full name to sign")
    .max(170, "Keep your name under 170 characters"),
  agreed: z.literal(true, "Agree to the waivers to sign them"),
});
export type GuardianSign = z.infer<typeof guardianSignSchema>;
