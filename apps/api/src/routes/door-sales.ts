import type { PrismaClient } from "@ticketapp/db";
import { doorSaleListSchema, doorSaleSchema } from "@ticketapp/shared";
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

/** How many sales the page lists at once; staff can page back through the rest. */
const SALE_PAGE = 50;

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
  // The door sales so far, a page at a time, and the cash they should have brought in.
  app.get("/orgs/:orgId/events/:eventId/door-sales", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const { before } = parse(doorSaleListSchema, request.query);
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
        ...(before ? { cursor: { id: before }, skip: 1 } : {}),
        take: SALE_PAGE + 1,
      }),
      // Cancelled sales were handed back, so they don't count.
      prisma.order.aggregate({
        where: { eventId, paymentMethod: "CASH", status: "PAID" },
        _sum: { totalCents: true },
        _count: true,
      }),
    ]);
    return {
      sales: sales.slice(0, SALE_PAGE),
      more: sales.length > SALE_PAGE,
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
    const { sale, repeat } = await prisma.$transaction(async (tx) => {
      // Every ticket issued for the event takes this lock, so two can't both take the last seat.
      const [event] = await tx.$queryRaw<{ capacity: number | null; status: string }[]>`
        SELECT capacity, status FROM "Event"
        WHERE id = ${eventId}::uuid AND "organizationId" = ${orgId}::uuid
        FOR UPDATE`;
      if (!event) throw new HttpError(404, "Event not found");
      // A sale sent again (say, after its response was lost) comes back as it was. Sales for the
      // event wait on the lock above, so a repeat can't slip in between this check and the insert.
      // One read, so the status checked below is the status of the sale sent back.
      const earlier = await tx.order.findUnique({
        where: { doorSaleKey: input.saleKey },
        select: {
          ...saleFields,
          eventId: true,
          tickets: { select: { ticketTypeId: true, ticketType: { select: { name: true } } } },
        },
      });
      if (earlier) {
        // Postgres hands UUIDs back in lowercase, whatever case they were sent in.
        if (earlier.eventId !== eventId.toLowerCase()) {
          throw new HttpError(409, "That sale was for another event");
        }
        // Only the very same sale counts as a repeat. Anything else would report a sale that
        // wasn't recorded, so staff check the list before selling again.
        const same =
          earlier.buyerName === `${input.firstName} ${input.lastName}` &&
          earlier.buyerEmail === (input.email ?? null) &&
          earlier.tickets.length === input.quantity &&
          earlier.tickets.every((tk) => tk.ticketTypeId === input.ticketTypeId.toLowerCase());
        if (!same) {
          throw new HttpError(
            409,
            "That sale was already recorded with different details. Check the sales list before selling again",
          );
        }
        if (earlier.status !== "PAID") {
          throw new HttpError(
            409,
            "That sale has since been cancelled. Check the sales list before selling again",
          );
        }
        return { sale: earlier, repeat: true };
      }
      if (event.status === "CANCELLED") throw new HttpError(409, "This event is cancelled");
      if (event.status !== "PUBLISHED") {
        throw new HttpError(409, "Publish the event before selling tickets");
      }
      const [ticketType] = await tx.$queryRaw<
        { name: string; priceCents: number; quantity: number | null; hasWaivers: boolean }[]
      >`
        SELECT name, "priceCents", quantity,
          EXISTS (SELECT 1 FROM "TicketTypeWaiver" w WHERE w."ticketTypeId" = "TicketType".id)
            AS "hasWaivers"
        FROM "TicketType"
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
      const sale = await tx.order.create({
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
          doorSaleKey: input.saleKey,
          tickets: {
            create: Array.from({ length: input.quantity }, () => ({
              code: newTicketCode(),
              event: { connect: { id: eventId } },
              ticketType: { connect: { id: input.ticketTypeId } },
              waiversRequired: ticketType.hasWaivers,
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
      return { sale, repeat: false };
    });
    if (sale.buyerEmail) await confirm(sale.id);
    return reply.code(repeat ? 200 : 201).send({ sale });
  });
}
