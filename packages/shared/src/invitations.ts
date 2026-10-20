import { z } from "zod";
import { roleSchema } from "./roles";

export const INVITATION_TTL_DAYS = 7;

export const createInvitationSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  role: roleSchema,
});
export type CreateInvitation = z.infer<typeof createInvitationSchema>;

export const invitationTokenSchema = z.object({
  token: z.string().min(20).max(200),
});

export const acceptInvitationSchema = invitationTokenSchema.extend({
  name: z.string().trim().min(1).max(100).optional(),
});
export type AcceptInvitation = z.infer<typeof acceptInvitationSchema>;
