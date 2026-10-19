import { z } from "zod";

export const organizationTypeSchema = z.enum(["SCHOOL", "COMMITTEE", "NONPROFIT"]);

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens"),
  type: organizationTypeSchema,
  timezone: z.string().min(1).max(64).optional(),
});
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = createOrganizationSchema
  .pick({ name: true, timezone: true })
  .partial();
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;
