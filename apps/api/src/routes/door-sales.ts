import type { PrismaClient } from "@ticketapp/db";
import { doorSaleSchema } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import type { ConfirmOrder } from "../lib/confirmations";
import { HttpError } from "../lib/errors";
import { settleLapsedHolds } from "../lib/orders";
import type { Payments } from "../lib/payments";
import { takesSeat } from "../lib/seats";
import { parse } from "../lib/validate";
import { newTicketCode } from "./comps";

const eventParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });

const saleFields = {
  id: true,
  status: true,
  buyerName: true,
  buyerEmail: true,
  totalCents: true,
  createdAt: true,
  soldBy: { select: { name: true } },
  tickets: { select: { ticketType: { select: { name: true } } } },
} as const;

/** Tickets sold at the door for cash. Door staff can sell as well as scan. */
export async function doorSaleRoutes(
  app: FastifyInstance,
  {
    prisma,
    payments,
    confirm,
  }: { prisma: PrismaClient; payments?: Payments; confirm: ConfirmOrder },
) {
  // Today's door sales and the cash they should have brought in.
  app.get("/orgs/:orgId/events/:eventId/door-sales", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true },
    });
    if (!event) throw new HttpError(404, "Event not found");
    const [sales, collected] = await Promise.all([
      prisma.order.findMany({
        where: { eventId, paymentMethod: "CASH" },
        select: saleFields,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
      }),
      // Cancelled sales were handed back, so they don't count.
      prisma.order.aggregate({
        where: { eventId, paymentMethod: "CASH", status: "PAID" },
        _sum: { totalCents: true },
        _count: true,
      }),
    ]);
    return {
      sales,
      cashCents: collected._sum.totalCents ?? 0,
      saleCount: collected._count,
    };
  });

  app.post("/orgs/:orgId/events/:eventId/door-sales", async (request, reply) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    const { user } = await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const input = parse(doorSaleSchema, request.body);
    const owned = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true },
    });
    if (!owned) throw new HttpError(404, "Event not found");
    // Abandoned checkouts give their seats back first. If Stripe can't be asked, they stay taken.
    await settleLapsedHolds(prisma, payments, eventId, { onPaid: confirm }).catch((err) =>
      request.log.warn({ err }, "Couldn't settle lapsed checkouts"),
    );
    const sale = await prisma.$transaction(async (tx) => {
      // Every ticket issued for the event takes this lock, so two can't both take the last seat.
      const [event] = await tx.$queryRaw<{ capacity: number | null; status: string }[]>`
        SELECT capacity, status FROM "Event"
        WHERE id = ${eventId}::uuid AND "organizationId" = ${orgId}::uuid
        FOR UPDATE`;
      if (!event) throw new HttpError(404, "Event not found");
      if (event.status === "CANCELLED") throw new HttpError(409, "This event is cancelled");
      if (event.status !== "PUBLISHED") {
        throw new HttpError(409, "Publish the event before selling tickets");
      }
      const [ticketType] = await tx.$queryRaw<
        { name: string; priceCents: number; quantity: number | null }[]
      >`
        SELECT name, "priceCents", quantity FROM "TicketType"
        WHERE id = ${input.ticketTypeId}::uuid AND "eventId" = ${eventId}::uuid
        FOR UPDATE`;
      if (!ticketType) throw new HttpError(400, "Pick a ticket type from this event");
      // Staff at the door decide who gets in, so online sale windows and eligibility rules don't
      // apply, but the limits do.
      const seats = takesSeat;
      if (ticketType.quantity !== null) {
        const sold = await tx.ticket.count({
          where: { ticketTypeId: input.ticketTypeId, ...seats },
        });
        const left = ticketType.quantity - sold;
        if (left < input.quantity) {
          throw new HttpError(
            409,
            left > 0
              ? `Only ${left} ${ticketType.name} tickets are left`
              : `${ticketType.name} tickets are sold out`,
          );
        }
      }
      if (event.capacity !== null) {
        const issued = await tx.ticket.count({ where: { eventId, ...seats } });
        const left = event.capacity - issued;
        if (left < input.quantity) {
          throw new HttpError(
            409,
            left > 0 ? `Only ${left} tickets are left for this event` : "The event is at capacity",
          );
        }
      }
      const totalCents = ticketType.priceCents * input.quantity;
      return tx.order.create({
        data: {
          eventId,
          buyerName: `${input.firstName} ${input.lastName}`,
          buyerEmail: input.email ?? null,
          status: "PAID",
          paymentMethod: "CASH",
          // Cash never goes through Stripe, so there are no card or service fees.
          subtotalCents: totalCents,
          totalCents,
          soldById: user.id,
          tickets: {
            create: Array.from({ length: input.quantity }, () => ({
              code: newTicketCode(),
              event: { connect: { id: eventId } },
              ticketType: { connect: { id: input.ticketTypeId } },
              attendee: {
                create: {
                  firstName: input.firstName,
                  lastName: input.lastName,
                  email: input.email ?? null,
                },
              },
            })),
          },
        },
        select: saleFields,
      });
    });
    if (sale.buyerEmail) await confirm(sale.id);
    return reply.code(201).send({ sale });
  });
}
