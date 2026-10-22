import { Prisma, type PrismaClient } from "@ticketapp/db";
import { createCompSchema } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { notSendingConfirmation, type ConfirmOrder } from "../lib/confirmations";
import { HttpError } from "../lib/errors";
import { settleLapsedHolds } from "../lib/orders";
import type { Payments } from "../lib/payments";
import { takesSeat } from "../lib/seats";
import { parse } from "../lib/validate";

const eventParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });
const compParamsSchema = eventParamsSchema.extend({ orderId: z.uuid() });

const compFields = {
  id: true,
  buyerName: true,
  buyerEmail: true,
  note: true,
  status: true,
  createdAt: true,
  compedBy: { select: { name: true } },
  tickets: {
    // Whoever has it now, if it was given to someone else.
    where: { transferredTo: { is: null } },
    select: {
      id: true,
      status: true,
      ticketType: { select: { id: true, name: true } },
      attendee: { select: { firstName: true, lastName: true } },
    },
  },
} as const satisfies Prisma.OrderSelect;

/** What the QR code encodes: 128 random bits, so it can't be guessed. */
export const newTicketCode = () => randomBytes(16).toString("base64url");

export async function compRoutes(
  app: FastifyInstance,
  {
    prisma,
    payments,
    confirm,
  }: { prisma: PrismaClient; payments?: Payments; confirm: ConfirmOrder },
) {
  app.get("/orgs/:orgId/events/:eventId/comps", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true },
    });
    if (!event) throw new HttpError(404, "Event not found");
    const comps = await prisma.order.findMany({
      where: { eventId, paymentMethod: "COMP" },
      select: compFields,
      orderBy: { createdAt: "desc" },
    });
    return { comps };
  });

  app.post("/orgs/:orgId/events/:eventId/comps", async (request, reply) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    const { user } = await requireOrgPermission(prisma, request, orgId, "events.manage");
    const input = parse(createCompSchema, request.body);
    const owned = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true },
    });
    if (!owned) throw new HttpError(404, "Event not found");
    // Abandoned checkouts give their seats back first. If Stripe can't be asked, they stay taken.
    await settleLapsedHolds(prisma, payments, eventId, { onPaid: confirm }).catch((err) =>
      request.log.warn({ err }, "Couldn't settle lapsed checkouts"),
    );
    const comp = await prisma.$transaction(async (tx) => {
      // Every ticket issued for the event takes this lock, so two can't both take the last seat.
      const [event] = await tx.$queryRaw<{ capacity: number | null; status: string }[]>`
        SELECT capacity, status FROM "Event"
        WHERE id = ${eventId}::uuid AND "organizationId" = ${orgId}::uuid
        FOR UPDATE`;
      if (!event) throw new HttpError(404, "Event not found");
      if (event.status === "CANCELLED") throw new HttpError(409, "This event is cancelled");
      // Also lock the type, which is what a quantity edit locks before checking what's sold.
      const [ticketType] = await tx.$queryRaw<{ quantity: number | null }[]>`
        SELECT quantity FROM "TicketType"
        WHERE id = ${input.ticketTypeId}::uuid AND "eventId" = ${eventId}::uuid
        FOR UPDATE`;
      if (!ticketType) throw new HttpError(400, "Pick a ticket type from this event");
      // Read once the lock is held, so a waiver change being saved right now is seen.
      const hasWaivers =
        (await tx.ticketTypeWaiver.count({ where: { ticketTypeId: input.ticketTypeId } })) > 0;
      // Comps skip eligibility rules, but they still take a seat.
      const seats = takesSeat;
      if (ticketType.quantity !== null) {
        const sold = await tx.ticket.count({
          where: { ticketTypeId: input.ticketTypeId, ...seats },
        });
        if (sold >= ticketType.quantity) throw new HttpError(409, "That ticket type is sold out");
      }
      if (event.capacity !== null) {
        const issued = await tx.ticket.count({ where: { eventId, ...seats } });
        if (issued >= event.capacity) throw new HttpError(409, "The event is at capacity");
      }
      const attendee = await tx.attendee.create({
        data: { firstName: input.firstName, lastName: input.lastName, email: input.email },
      });
      return tx.order.create({
        data: {
          eventId,
          buyerName: `${input.firstName} ${input.lastName}`,
          buyerEmail: input.email,
          status: "PAID",
          paymentMethod: "COMP",
          subtotalCents: 0,
          totalCents: 0,
          compedById: user.id,
          note: input.note ?? null,
          tickets: {
            create: {
              code: newTicketCode(),
              eventId,
              ticketTypeId: input.ticketTypeId,
              attendeeId: attendee.id,
              // Nobody signs for a comp, so its waivers stay missing until they do.
              waiversRequired: hasWaivers,
            },
          },
        },
        select: compFields,
      });
    });
    await confirm(comp.id);
    return reply.code(201).send({ comp });
  });

  app.post("/orgs/:orgId/events/:eventId/comps/:orderId/void", async (request) => {
    const { orgId, eventId, orderId } = parse(compParamsSchema, request.params);
    const { user } = await requireOrgPermission(prisma, request, orgId, "events.manage");
    const comp = await prisma.$transaction(async (tx) => {
      const comp = {
        id: orderId,
        eventId,
        paymentMethod: "COMP" as const,
        event: { organizationId: orgId },
      };
      // Only the void itself records who did it and when; voiding again changes nothing. It waits
      // for a confirmation email that's going out, so it can't arrive after the void.
      const { count } = await tx.order.updateMany({
        where: { ...comp, status: "PAID", ...notSendingConfirmation() },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledById: user.id,
          emailViewKey: null,
          confirmationEmail: Prisma.DbNull,
        },
      });
      if (count === 0) {
        const current = await tx.order.findFirst({ where: comp, select: { status: true } });
        if (!current) throw new HttpError(404, "Comp ticket not found");
        if (current.status === "PAID") {
          throw new HttpError(409, "Its email is going out right now. Try again in a minute.");
        }
      } else {
        await tx.ticket.updateMany({ where: { orderId }, data: { status: "VOID" } });
      }
      return tx.order.findUniqueOrThrow({ where: { id: orderId }, select: compFields });
    });
    return { comp };
  });
}
