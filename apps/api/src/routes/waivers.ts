import { Prisma, type PrismaClient } from "@ticketapp/db";
import {
  archiveWaiverTemplateSchema,
  updateWaiverTemplateSchema,
  waiverTemplateSchema,
  type WaiverTemplateInput,
} from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { canonical } from "../lib/canonical";
import { HttpError } from "../lib/errors";
import { parse } from "../lib/validate";

const orgParamsSchema = z.object({ orgId: z.uuid() });
const waiverParamsSchema = orgParamsSchema.extend({ waiverId: z.uuid() });

const summaryFields = {
  id: true,
  title: true,
  version: true,
  requiresGuardianForMinors: true,
  fields: true,
  archivedAt: true,
  updatedAt: true,
  ticketTypes: {
    select: {
      ticketType: {
        select: {
          name: true,
          event: { select: { id: true, name: true, startsAt: true, endsAt: true } },
        },
      },
    },
    orderBy: [
      { ticketType: { event: { startsAt: "desc" } } },
      { ticketType: { createdAt: "asc" } },
    ],
  },
  _count: { select: { signatures: true } },
} as const satisfies Prisma.WaiverTemplateSelect;

const waiverFields = {
  ...summaryFields,
  body: true,
} as const satisfies Prisma.WaiverTemplateSelect;

type SummaryRow = Prisma.WaiverTemplateGetPayload<{ select: typeof summaryFields }>;
type WaiverRow = Prisma.WaiverTemplateGetPayload<{ select: typeof waiverFields }>;

/** The events whose tickets ask for the waiver, each with the ticket types that do. */
function eventsUsing(ticketTypes: SummaryRow["ticketTypes"]) {
  const events = new Map<
    string,
    { id: string; name: string; startsAt: Date; endsAt: Date; ticketTypes: string[] }
  >();
  for (const { ticketType } of ticketTypes) {
    const { event } = ticketType;
    const entry = events.get(event.id) ?? { ...event, ticketTypes: [] };
    entry.ticketTypes.push(ticketType.name);
    events.set(event.id, entry);
  }
  return [...events.values()];
}

function summary({ _count, fields, ticketTypes, ...waiver }: SummaryRow) {
  return {
    ...waiver,
    fieldCount: Array.isArray(fields) ? fields.length : 0,
    eventCount: eventsUsing(ticketTypes).length,
    signatureCount: _count.signatures,
  };
}

function present(waiver: WaiverRow) {
  return {
    ...summary(waiver),
    body: waiver.body,
    fields: waiver.fields,
    events: eventsUsing(waiver.ticketTypes),
  };
}

/** Whether a save changes anything a signer would see. */
function changes(
  current: { title: string; body: string; requiresGuardianForMinors: boolean; fields: unknown },
  input: WaiverTemplateInput,
) {
  return (
    current.title !== input.title ||
    current.body !== input.body ||
    current.requiresGuardianForMinors !== input.requiresGuardianForMinors ||
    canonical(current.fields) !== canonical(input.fields)
  );
}

/** Waiver templates an organization's events can ask attendees to sign. */
export async function waiverRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.get("/orgs/:orgId/waivers", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const waivers = await prisma.waiverTemplate.findMany({
      where: { organizationId: orgId },
      select: summaryFields,
      orderBy: [{ title: "asc" }, { id: "asc" }],
    });
    return { waivers: waivers.map(summary) };
  });

  app.get("/orgs/:orgId/waivers/:waiverId", async (request) => {
    const { orgId, waiverId } = parse(waiverParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const waiver = await prisma.waiverTemplate.findFirst({
      where: { id: waiverId, organizationId: orgId },
      select: waiverFields,
    });
    if (!waiver) throw new HttpError(404, "Waiver not found");
    return { waiver: present(waiver) };
  });

  app.post("/orgs/:orgId/waivers", async (request, reply) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const input = parse(waiverTemplateSchema, request.body);
    const waiver = await prisma.waiverTemplate.create({
      data: {
        ...input,
        organizationId: orgId,
        versions: { create: { ...input, version: 1 } },
      },
      select: waiverFields,
    });
    return reply.code(201).send({ waiver: present(waiver) });
  });

  // Every change to the wording or questions is a new version, kept alongside the old ones.
  app.put("/orgs/:orgId/waivers/:waiverId", async (request) => {
    const { orgId, waiverId } = parse(waiverParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const { version, ...input } = parse(updateWaiverTemplateSchema, request.body);
    const waiver = await prisma.$transaction(async (tx) => {
      // Locked, so two saves from the same version can't both become the next one.
      const [current] = await tx.$queryRaw<
        {
          version: number;
          title: string;
          body: string;
          requiresGuardianForMinors: boolean;
          fields: unknown;
        }[]
      >`
        SELECT version, title, body, "requiresGuardianForMinors", fields FROM "WaiverTemplate"
        WHERE id = ${waiverId}::uuid AND "organizationId" = ${orgId}::uuid
        FOR UPDATE`;
      if (!current) throw new HttpError(404, "Waiver not found");
      if (current.version !== version) {
        throw new HttpError(
          409,
          "Someone else saved changes to this waiver. Reload the page to see them before editing",
        );
      }
      if (changes(current, input)) {
        const next = current.version + 1;
        await tx.waiverTemplate.update({
          where: { id: waiverId },
          data: { ...input, version: next, versions: { create: { ...input, version: next } } },
        });
      }
      return tx.waiverTemplate.findUniqueOrThrow({ where: { id: waiverId }, select: waiverFields });
    });
    return { waiver: present(waiver) };
  });

  app.patch("/orgs/:orgId/waivers/:waiverId", async (request) => {
    const { orgId, waiverId } = parse(waiverParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const { archived } = parse(archiveWaiverTemplateSchema, request.body);
    const waiver = await prisma.$transaction(async (tx) => {
      const { count } = await tx.waiverTemplate.updateMany({
        where: { id: waiverId, organizationId: orgId },
        data: { archivedAt: archived ? new Date() : null },
      });
      if (count === 0) throw new HttpError(404, "Waiver not found");
      return tx.waiverTemplate.findUniqueOrThrow({ where: { id: waiverId }, select: waiverFields });
    });
    return { waiver: present(waiver) };
  });

  // Only a waiver nothing uses can go; one that tickets use or people have signed is archived.
  app.delete("/orgs/:orgId/waivers/:waiverId", async (request, reply) => {
    const { orgId, waiverId } = parse(waiverParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const { count } = await prisma.waiverTemplate
      .deleteMany({ where: { id: waiverId, organizationId: orgId } })
      .catch((err: unknown) => {
        // Ticket types and signatures keep the waiver they use (onDelete: Restrict).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
          throw new HttpError(409, "Tickets use this waiver, so archive it instead");
        }
        throw err;
      });
    if (count === 0) throw new HttpError(404, "Waiver not found");
    return reply.code(204).send();
  });
}
