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
