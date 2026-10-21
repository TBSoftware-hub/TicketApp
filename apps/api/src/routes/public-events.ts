import type { PrismaClient } from "@ticketapp/db";
import { ticketSaleStatus } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/errors";
import type { Payments } from "../lib/payments";
import { shownAsTaken } from "../lib/seats";
import { parse } from "../lib/validate";

const slug = z.string().min(1).max(80);
const paramsSchema = z.object({ orgSlug: slug, eventSlug: slug });

/** What anyone with the link can see. No sign-in; drafts stay hidden. */
export async function publicEventRoutes(
  app: FastifyInstance,
  { prisma, payments }: { prisma: PrismaClient; payments?: Payments },
) {
  app.get("/public/events/:orgSlug/:eventSlug", async (request) => {
    const { orgSlug, eventSlug } = parse(paramsSchema, request.params);
    const now = new Date();
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
        organization: {
          select: {
            name: true,
            timezone: true,
            stripeAccountId: true,
            stripeChargesEnabled: true,
            stripeLivemode: true,
            cardFeePaidBy: true,
            serviceFeePaidBy: true,
          },
        },
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
            waivers: {
              orderBy: { waiverTemplate: { title: "asc" } },
              select: {
                waiverTemplate: {
                  select: {
                    id: true,
                    version: true,
                    title: true,
                    body: true,
                    fields: true,
                    requiresGuardianForMinors: true,
                  },
                },
              },
            },
            // Seats held for buyers who are paying count too, so the page doesn't oversell.
            _count: { select: { tickets: { where: shownAsTaken(now) } } },
          },
        },
      },
    });
    if (!event) throw new HttpError(404, "Event not found");

    const { capacity, organization, ticketTypes, ...rest } = event;
    // Each waiver once, however many ticket types ask for it.
    const waivers = new Map(
      ticketTypes.flatMap((tt) => tt.waivers.map((w) => [w.waiverTemplate.id, w.waiverTemplate])),
    );
    const soldForEvent = ticketTypes.reduce((n, tt) => n + tt._count.tickets, 0);
    const eventRemaining = capacity === null ? null : capacity - soldForEvent;
    const onlinePayments = Boolean(
      payments &&
      organization.stripeAccountId &&
      organization.stripeChargesEnabled &&
      organization.stripeLivemode === payments.livemode,
    );
    return {
      event: {
        ...rest,
        organizationName: organization.name,
        timezone: organization.timezone,
        onlinePayments,
        cardFeePaidBy: organization.cardFeePaidBy,
        serviceFeePaidBy: organization.serviceFeePaidBy,
      },
      // Counts stay private; buyers only see whether they can buy.
      ticketTypes: ticketTypes.map(({ _count, quantity, waivers, ...tt }) => ({
        ...tt,
        waiverIds: waivers.map((w) => w.waiverTemplate.id),
        saleStatus:
          event.status === "CANCELLED"
            ? ("ended" as const)
            : ticketSaleStatus(
                { quantity, salesStartAt: tt.salesStartAt, salesEndAt: tt.salesEndAt },
                { sold: _count.tickets, eventEndsAt: event.endsAt, eventRemaining, now },
              ),
      })),
      waivers: [...waivers.values()],
    };
  });
}
