import { z } from "zod";

export const magicLinkRequestSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  name: z.string().trim().min(1).max(100).optional(),
});
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;

export const verifyMagicLinkSchema = z.object({
  token: z.string().min(20).max(200),
});
export type VerifyMagicLink = z.infer<typeof verifyMagicLinkSchema>;

/** The door app signs in with a six-digit emailed code, since staff often read email on another device. */
export const signInCodeRequestSchema = magicLinkRequestSchema.pick({ email: true });
export type SignInCodeRequest = z.infer<typeof signInCodeRequestSchema>;

export const verifySignInCodeSchema = z.object({
  email: magicLinkRequestSchema.shape.email,
  // Tolerate the space the email shows in the middle of the code, and any pasted around it.
  code: z
    .string()
    .transform((c) => c.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\d{6}$/, "Enter the six-digit code from the email")),
});
export type VerifySignInCode = z.infer<typeof verifySignInCodeSchema>;
