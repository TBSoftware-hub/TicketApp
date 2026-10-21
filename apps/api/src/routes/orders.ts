import { Prisma, type PrismaClient } from "@ticketapp/db";
import { formatCents, orderSearchSchema } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import type { Mailer } from "../lib/mailer";
import type { Payments } from "../lib/payments";
import { parse } from "../lib/validate";

const eventParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });
const orderParamsSchema = eventParamsSchema.extend({ orderId: z.uuid() });

/** How many orders the dashboard lists at once; a search narrows it down. */
const ORDER_PAGE = 100;

const orderFields = {
  id: true,
  status: true,
  paymentMethod: true,
  buyerName: true,
  buyerEmail: true,
  totalCents: true,
  refundedCents: true,
  createdAt: true,
  cancelledAt: true,
  cancelledBy: { select: { name: true } },
  promoCode: { select: { code: true } },
  tickets: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      status: true,
      ticketType: { select: { name: true } },
      attendee: { select: { firstName: true, lastName: true } },
    },
  },
} as const satisfies Prisma.OrderSelect;

/** Orders staff manage from the dashboard. */
export async function orderRoutes(
  app: FastifyInstance,
  { prisma, payments, mailer }: { prisma: PrismaClient; payments?: Payments; mailer: Mailer },
) {
  const findEvent = async (orgId: string, eventId: string) => {
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true, name: true, organization: { select: { name: true } } },
    });
    if (!event) throw new HttpError(404, "Event not found");
    return event;
  };

  app.get("/orgs/:orgId/events/:eventId/orders", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const { q } = parse(orderSearchSchema, request.query);
    await findEvent(orgId, eventId);
    const contains = (value: string) => ({ contains: value, mode: "insensitive" as const });
    const orders = await prisma.order.findMany({
      where: {
        eventId,
        // Checkouts that were never paid for aren't orders anyone needs to manage.
        OR: [
          { status: { in: ["PAID", "REFUNDED"] } },
          { status: "CANCELLED", cancelledAt: { not: null } },
        ],
        ...(q
          ? {
              AND: [
                {
                  OR: [
                    { buyerName: contains(q) },
                    { buyerEmail: contains(q) },
                    { tickets: { some: { attendee: { firstName: contains(q) } } } },
                    { tickets: { some: { attendee: { lastName: contains(q) } } } },
                  ],
                },
              ],
            }
          : {}),
      },
      select: orderFields,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ORDER_PAGE + 1,
    });
    return { orders: orders.slice(0, ORDER_PAGE), more: orders.length > ORDER_PAGE };
  });

  // Cancels a paid order and voids its tickets, refunding the card in full if it was paid for.
  app.post("/orgs/:orgId/events/:eventId/orders/:orderId/cancel", async (request) => {
    const { orgId, eventId, orderId } = parse(orderParamsSchema, request.params);
    const { user } = await requireOrgPermission(prisma, request, orgId, "events.manage");
    const event = await findEvent(orgId, eventId);
    const order = await prisma.order.findFirst({
      where: { id: orderId, eventId },
      select: {
        status: true,
        paymentMethod: true,
        totalCents: true,
        stripePaymentIntentId: true,
        buyerName: true,
        buyerEmail: true,
        _count: { select: { tickets: true } },
      },
    });
    if (!order) throw new HttpError(404, "Order not found");
    if (order.status === "PENDING") {
      throw new HttpError(409, "This order is still being paid for. Try again in a few minutes.");
    }
    if (order.status !== "PAID") throw new HttpError(409, "This order is already cancelled");

    let refund: { id: string } | null = null;
    if (order.paymentMethod === "CARD" && order.totalCents > 0) {
      if (!payments || !order.stripePaymentIntentId) {
        throw new HttpError(409, "This order can't be refunded here. Refund it from Stripe.");
      }
      // Refunding first means a failure leaves the order as it was, ready to try again. The same
      // order always gets the same refund, so two clicks can't refund it twice.
      refund = await payments.refund({ orderId, paymentIntentId: order.stripePaymentIntentId });
    }

    const cancelled = await prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: "PAID" },
        data: {
          status: refund ? "REFUNDED" : "CANCELLED",
          cancelledAt: new Date(),
          cancelledById: user.id,
          refundedCents: refund ? order.totalCents : 0,
          stripeRefundId: refund?.id ?? null,
          // A confirmation email that hasn't gone out yet never will.
          emailViewKey: null,
          confirmationEmail: Prisma.DbNull,
        },
      });
      if (count === 0) return false;
      await tx.ticket.updateMany({ where: { orderId }, data: { status: "VOID" } });
      return true;
    });

    // Only the request that cancelled it tells the buyer, so two clicks send one email.
    if (cancelled) {
      const plural = order._count.tickets === 1 ? "ticket" : "tickets";
      const text = [
        `Hi ${order.buyerName},`,
        "",
        `${event.organization.name} cancelled your ${plural} for ${event.name}. Their QR ${order._count.tickets === 1 ? "code no longer works" : "codes no longer work"} at the door.`,
        ...(refund
          ? [
              "",
              `${formatCents(order.totalCents)} is on its way back to the card you paid with. It can take 5 to 10 business days to show up.`,
            ]
          : []),
        "",
        `If you have questions, contact ${event.organization.name}.`,
      ].join("\n");
      try {
        await mailer.send({
          to: order.buyerEmail,
          subject: `Your ${plural} for ${event.name} ${order._count.tickets === 1 ? "was" : "were"} ${refund ? "refunded" : "cancelled"}`,
          text,
          idempotencyKey: `order-cancelled-${orderId}`,
        });
      } catch (err) {
        request.log.error({ err, orderId }, "Couldn't send the cancellation email");
      }
    }

    return {
      order: await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: orderFields }),
    };
  });
}
