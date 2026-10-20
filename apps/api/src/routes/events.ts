import { Prisma, type PrismaClient } from "@ticketapp/db";
import { createEventSchema, updateEventSchema } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { parse } from "../lib/validate";

const orgParamsSchema = z.object({ orgId: z.uuid() });
const eventParamsSchema = orgParamsSchema.extend({ eventId: z.uuid() });

const eventFields = {
  id: true,
  name: true,
  slug: true,
  description: true,
  venue: true,
  startsAt: true,
  endsAt: true,
  capacity: true,
  status: true,
} as const;

function slugTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw new HttpError(409, "Another event already uses that web address");
  }
  throw err;
}

export async function eventRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.get("/orgs/:orgId/events", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "org.view");
    const events = await prisma.event.findMany({
      where: { organizationId: orgId },
      select: eventFields,
      orderBy: { startsAt: "asc" },
    });
    return { events };
  });

  app.post("/orgs/:orgId/events", async (request, reply) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const input = parse(createEventSchema, request.body);
    const event = await prisma.event
      .create({ data: { ...input, organizationId: orgId }, select: eventFields })
      .catch(slugTaken);
    return reply.code(201).send({ event });
  });

  app.get("/orgs/:orgId/events/:eventId", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "org.view");
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: eventFields,
    });
    if (!event) throw new HttpError(404, "Event not found");
    return { event };
  });

  app.patch("/orgs/:orgId/events/:eventId", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const input = parse(updateEventSchema, request.body);
    const current = await prisma.event.findFirst({ where: { id: eventId, organizationId: orgId } });
    if (!current) throw new HttpError(404, "Event not found");
    // A change to only one end of the event still has to leave it ending after it starts.
    if ((input.endsAt ?? current.endsAt) <= (input.startsAt ?? current.startsAt)) {
      throw new HttpError(400, "The event has to end after it starts");
    }
    const event = await prisma.event
      .update({ where: { id: eventId }, data: input, select: eventFields })
      .catch(slugTaken);
    return { event };
  });
}
