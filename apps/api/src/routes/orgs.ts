import { Prisma, type PrismaClient } from "@ticketapp/db";
import { createOrganizationSchema, updateOrganizationSchema } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission, requireUser } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { parse } from "../lib/validate";

const orgParamsSchema = z.object({ orgId: z.uuid() });

const publicOrg = { id: true, name: true, slug: true, type: true, timezone: true } as const;

export async function orgRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  // Any signed-in staff member can start an organization and becomes its owner.
  app.post("/orgs", async (request, reply) => {
    const user = await requireUser(prisma, request);
    const input = parse(createOrganizationSchema, request.body);
    try {
      const org = await prisma.organization.create({
        data: { ...input, memberships: { create: { userId: user.id, role: "OWNER" } } },
        select: publicOrg,
      });
      return reply.code(201).send({ organization: org, role: "OWNER" });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(409, "That web address is already taken");
      }
      throw err;
    }
  });

  app.get("/orgs/:orgId", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    const { role } = await requireOrgPermission(prisma, request, orgId, "org.view");
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: publicOrg,
    });
    return { organization: org, role };
  });

  app.patch("/orgs/:orgId", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "org.manage");
    const input = parse(updateOrganizationSchema, request.body);
    const org = await prisma.organization.update({
      where: { id: orgId },
      data: input,
      select: publicOrg,
    });
    return { organization: org };
  });
}
