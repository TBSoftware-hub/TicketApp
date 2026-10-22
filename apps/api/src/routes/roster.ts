import type { Prisma, PrismaClient } from "@ticketapp/db";
import { MAX_ROSTER_BYTES, parseRosterCsv, rosterImportSchema } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { parse } from "../lib/validate";

const paramsSchema = z.object({ orgId: z.uuid() });

/** Rows per insert, well under Postgres's limit on query parameters. */
const INSERT_BATCH = 5_000;

/**
 * Changes to the roster lock the organization row, and checkout takes a shared lock on it while
 * it checks students, so a checkout sees either the whole old roster or the whole new one.
 */
function lockOrganization(tx: Prisma.TransactionClient, orgId: string) {
  return tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId}::uuid FOR UPDATE`;
}

/** What's on file, without listing students: how many, in which grades, and since when. */
async function rosterSummary(prisma: Prisma.TransactionClient, orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { rosterImportedAt: true },
  });
  if (!org.rosterImportedAt) return { roster: null };
  const grades = await prisma.rosterStudent.groupBy({
    by: ["grade"],
    where: { organizationId: orgId },
    _count: { _all: true },
    orderBy: { grade: "asc" },
  });
  return {
    roster: {
      importedAt: org.rosterImportedAt,
      students: grades.reduce((n, g) => n + g._count._all, 0),
      grades: grades.map((g) => ({ grade: g.grade, students: g._count._all })),
    },
  };
}

/**
 * The organization's student roster, which checkout matches students-only tickets against.
 * Rosters are student records, so only staff who manage events can see or change one, and even
 * they only see counts here.
 */
export async function rosterRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.get("/orgs/:orgId/roster", async (request) => {
    const { orgId } = parse(paramsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    return rosterSummary(prisma, orgId);
  });

  app.put(
    "/orgs/:orgId/roster",
    // Room for the CSV once it's wrapped in JSON, which escapes quotes and line breaks.
    { bodyLimit: MAX_ROSTER_BYTES * 2 },
    async (request, reply) => {
      const { orgId } = parse(paramsSchema, request.params);
      await requireOrgPermission(prisma, request, orgId, "events.manage");
      const { csv } = parse(rosterImportSchema, request.body);
      const parsed = parseRosterCsv(csv);
      if (!parsed.ok) {
        return reply.code(400).send({
          error: "Nothing was imported. Fix these rows and try again",
          problems: parsed.problems,
        });
      }

      // The new roster replaces the old one in full, so students who've left drop off.
      return prisma.$transaction(
        async (tx) => {
          // One import at a time, so two can't interleave their rows.
          await lockOrganization(tx, orgId);
          await tx.rosterStudent.deleteMany({ where: { organizationId: orgId } });
          for (let i = 0; i < parsed.students.length; i += INSERT_BATCH) {
            await tx.rosterStudent.createMany({
              data: parsed.students
                .slice(i, i + INSERT_BATCH)
                .map((s) => ({ ...s, organizationId: orgId })),
            });
          }
          await tx.organization.update({
            where: { id: orgId },
            data: { rosterImportedAt: new Date() },
          });
          // Read before the lock is let go, so it's this import's roster being described.
          return rosterSummary(tx, orgId);
        },
        { timeout: 30_000 },
      );
    },
  );

  app.delete("/orgs/:orgId/roster", async (request, reply) => {
    const { orgId } = parse(paramsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    await prisma.$transaction(async (tx) => {
      // The lock imports take and checkouts wait on, so removal waits its turn.
      await lockOrganization(tx, orgId);
      await tx.rosterStudent.deleteMany({ where: { organizationId: orgId } });
      await tx.organization.update({ where: { id: orgId }, data: { rosterImportedAt: null } });
    });
    return reply.code(204).send();
  });
}
