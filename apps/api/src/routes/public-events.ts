import type { PrismaClient } from "@ticketapp/db";
import { ticketSaleStatus } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/errors";
import { parse } from "../lib/validate";

const slug = z.string().min(1).max(80);
const paramsSchema = z.object({ orgSlug: slug, eventSlug: slug });

/** What anyone with the link can see. No sign-in; drafts stay hidden. */
export async function publicEventRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  app.get("/public/events/:orgSlug/:eventSlug", async (request) => {
    const { orgSlug, eventSlug } = parse(paramsSchema, request.params);
    const event = await prisma.event.findFirst({
      where: {
        slug: eventSlug,
        organization: { slug: orgSlug },
        status: { in: ["PUBLISHED", "CANCELLED"] },
      },
      select: {
        id: true,
        name: true,
        description: true,
        venue: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        status: true,
        organization: { select: { name: true, timezone: true } },
        ticketTypes: {
          orderBy: { createdAt: "asc" },
          select: {
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
          },
        },
      },
    });
    if (!event) throw new HttpError(404, "Event not found");

    const { capacity, organization, ticketTypes, ...rest } = event;
    const soldForEvent = ticketTypes.reduce((n, tt) => n + tt._count.tickets, 0);
    const eventRemaining = capacity === null ? null : capacity - soldForEvent;
    const now = new Date();
    return {
      event: { ...rest, organizationName: organization.name, timezone: organization.timezone },
      // Counts stay private; buyers only see whether they can buy.
      ticketTypes: ticketTypes.map(({ _count, quantity, ...tt }) => ({
        ...tt,
        saleStatus:
          event.status === "CANCELLED"
            ? ("ended" as const)
            : ticketSaleStatus(
                { quantity, salesStartAt: tt.salesStartAt, salesEndAt: tt.salesEndAt },
                { sold: _count.tickets, eventEndsAt: event.endsAt, eventRemaining, now },
              ),
      })),
    };
  });
}
