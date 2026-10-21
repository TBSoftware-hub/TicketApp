import { Prisma, type PrismaClient } from "@ticketapp/db";
import {
  createTicketTypeSchema,
  eligibilityRulesProblem,
  updateTicketTypeSchema,
} from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { takesSeat } from "../lib/seats";
import { parse } from "../lib/validate";

const eventParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });
const ticketTypeParamsSchema = eventParamsSchema.extend({ ticketTypeId: z.uuid() });

const ticketTypeFields = {
  id: true,
  name: true,
  priceCents: true,
  quantity: true,
  maxPerOrder: true,
  salesStartAt: true,
  salesEndAt: true,
  studentsOnly: true,
  minGrade: true,
  maxGrade: true,
  requiresApproval: true,
  _count: { select: { tickets: { where: { status: "VALID" } } } },
  // Any ticket at all, voided ones included, keeps the type from being deleted.
  tickets: { select: { id: true }, take: 1 },
} as const satisfies Prisma.TicketTypeSelect;

type TicketTypeRow = Prisma.TicketTypeGetPayload<{ select: typeof ticketTypeFields }>;

function present({ _count, tickets, ...ticketType }: TicketTypeRow) {
  return { ...ticketType, sold: _count.tickets, hasTickets: tickets.length > 0 };
}

export async function ticketTypeRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  async function requireEvent(orgId: string, eventId: string) {
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true },
    });
    if (!event) throw new HttpError(404, "Event not found");
  }

  app.get("/orgs/:orgId/events/:eventId/ticket-types", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "org.view");
    await requireEvent(orgId, eventId);
    const ticketTypes = await prisma.ticketType.findMany({
      where: { eventId },
      select: ticketTypeFields,
      orderBy: { createdAt: "asc" },
    });
    return { ticketTypes: ticketTypes.map(present) };
  });

  app.post("/orgs/:orgId/events/:eventId/ticket-types", async (request, reply) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const input = parse(createTicketTypeSchema, request.body);
    await requireEvent(orgId, eventId);
    const ticketType = await prisma.ticketType.create({
      data: { ...input, eventId },
      select: ticketTypeFields,
    });
    return reply.code(201).send({ ticketType: present(ticketType) });
  });

  app.patch("/orgs/:orgId/events/:eventId/ticket-types/:ticketTypeId", async (request) => {
    const { orgId, eventId, ticketTypeId } = parse(ticketTypeParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const input = parse(updateTicketTypeSchema, request.body);
    // Lock the row so a concurrent edit or sale can't slip past the checks below.
    const ticketType = await prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<
        {
          salesStartAt: Date | null;
          salesEndAt: Date | null;
          studentsOnly: boolean;
          minGrade: number | null;
          maxGrade: number | null;
        }[]
      >`
        SELECT t."salesStartAt", t."salesEndAt", t."studentsOnly", t."minGrade", t."maxGrade"
        FROM "TicketType" t
        JOIN "Event" e ON e.id = t."eventId"
        WHERE t.id = ${ticketTypeId}::uuid AND t."eventId" = ${eventId}::uuid
          AND e."organizationId" = ${orgId}::uuid
        FOR UPDATE OF t`;
      if (!current) throw new HttpError(404, "Ticket type not found");
      // A change to only one end of the sale window still has to leave it ending after it starts.
      const start = input.salesStartAt === undefined ? current.salesStartAt : input.salesStartAt;
      const end = input.salesEndAt === undefined ? current.salesEndAt : input.salesEndAt;
      if (start && end && end <= start) {
        throw new HttpError(400, "Sales have to end after they start");
      }
      // Likewise the eligibility rules have to hold together once merged with what's stored.
      const problem = eligibilityRulesProblem({
        studentsOnly: input.studentsOnly ?? current.studentsOnly,
        minGrade: input.minGrade === undefined ? current.minGrade : input.minGrade,
        maxGrade: input.maxGrade === undefined ? current.maxGrade : input.maxGrade,
      });
      if (problem) throw new HttpError(400, problem);
      if (input.quantity != null) {
        // Seats held for buyers who are paying can't be taken back either.
        const sold = await tx.ticket.count({ where: { ticketTypeId, ...takesSeat() } });
        if (input.quantity < sold) {
          throw new HttpError(409, `${sold} of these tickets are already sold or being bought`);
        }
      }
      return tx.ticketType.update({
        where: { id: ticketTypeId },
        data: input,
        select: ticketTypeFields,
      });
    });
    return { ticketType: present(ticketType) };
  });

  app.delete("/orgs/:orgId/events/:eventId/ticket-types/:ticketTypeId", async (request, reply) => {
    const { orgId, eventId, ticketTypeId } = parse(ticketTypeParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    await prisma
      .$transaction(async (tx) => {
        // Creating a promo code locks the types it names, so the check below can't miss one.
        const [current] = await tx.$queryRaw<{ id: string }[]>`
          SELECT t.id FROM "TicketType" t
          JOIN "Event" e ON e.id = t."eventId"
          WHERE t.id = ${ticketTypeId}::uuid AND t."eventId" = ${eventId}::uuid
            AND e."organizationId" = ${orgId}::uuid
          FOR UPDATE OF t`;
        if (!current) throw new HttpError(404, "Ticket type not found");
        // Dropping a promo's last type would silently turn it into a code for every type.
        const promos = await tx.promoCode.count({
          where: { ticketTypes: { some: { id: ticketTypeId } } },
        });
        if (promos > 0) {
          throw new HttpError(409, "A promo code is limited to this type, so it can't be deleted");
        }
        await tx.ticketType.delete({ where: { id: ticketTypeId } });
      })
      .catch((err: unknown) => {
        // Tickets keep their type (onDelete: Restrict), so a sold type can't be removed.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
          throw new HttpError(
            409,
            "Tickets have been issued for this type, so it can't be deleted",
          );
        }
        throw err;
      });
    return reply.code(204).send();
  });
}
