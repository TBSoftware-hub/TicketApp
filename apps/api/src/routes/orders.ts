import { Prisma, type PrismaClient } from "@ticketapp/db";
import { orderSearchSchema } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { cancellationEmail, type CancellationNotices } from "../lib/cancellations";
import { notSendingConfirmation } from "../lib/confirmations";
import type { Payments, RefundResult } from "../lib/payments";
import { parse } from "../lib/validate";

const eventParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });
const orderParamsSchema = eventParamsSchema.extend({ orderId: z.uuid() });

const SENDING_CONFIRMATION =
  "The confirmation email for this order is going out right now. Try again in a minute.";

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
  {
    prisma,
    payments,
    notices,
  }: { prisma: PrismaClient; payments?: Payments; notices: CancellationNotices },
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
          // Comps voided before cancellations were recorded have no time, but were still issued.
          { status: "CANCELLED", paymentMethod: "COMP" },
        ],
        // Every word has to match somewhere, so "Sam Lee" finds Sam Lee's ticket.
        AND: (q?.split(/\s+/) ?? []).map((word) => ({
          OR: [
            { buyerName: contains(word) },
            { buyerEmail: contains(word) },
            { tickets: { some: { attendee: { firstName: contains(word) } } } },
            { tickets: { some: { attendee: { lastName: contains(word) } } } },
          ],
        })),
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

    // Checked again when cancelling; this just avoids refunding an order that can't be cancelled yet.
    const busy = await prisma.order.count({
      where: { id: orderId, NOT: notSendingConfirmation() },
    });
    if (busy > 0) throw new HttpError(409, SENDING_CONFIRMATION);

    let refund: RefundResult | null = null;
    if (order.paymentMethod === "CARD" && order.totalCents > 0) {
      if (!payments || !order.stripePaymentIntentId) {
        throw new HttpError(409, "This order can't be refunded here. Refund it from Stripe.");
      }
      // Refunding first means a failure leaves the order as it was, ready to try again. The same
      // order always gets the same refund, so two clicks can't refund it twice.
      refund = await payments.refund({ orderId, paymentIntentId: order.stripePaymentIntentId });
      if (refund.status === "failed" || refund.status === "canceled") {
        throw new HttpError(502, "Stripe couldn't refund this payment. Check it in Stripe.");
      }
    }

    const refundedCents = refund ? order.totalCents : 0;
    const email = cancellationEmail({
      buyerName: order.buyerName,
      buyerEmail: order.buyerEmail,
      ticketCount: order._count.tickets,
      refundedCents,
      event: { name: event.name, organizationName: event.organization.name },
    });
    const outcome = await prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: "PAID", ...notSendingConfirmation() },
        data: {
          status: refund ? "REFUNDED" : "CANCELLED",
          cancelledAt: new Date(),
          cancelledById: user.id,
          refundedCents,
          stripeRefundId: refund?.id ?? null,
          stripeRefundStatus: refund?.status ?? null,
          // A confirmation email that hasn't gone out yet never will.
          emailViewKey: null,
          confirmationEmail: Prisma.DbNull,
          // Kept until it's sent, so a mail outage doesn't leave the buyer unaware.
          cancellationEmail: email as unknown as Prisma.InputJsonObject,
        },
      });
      if (count > 0) {
        await tx.ticket.updateMany({ where: { orderId }, data: { status: "VOID" } });
        return "cancelled";
      }
      const { status } = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { status: true },
      });
      // Someone else cancelled it first, or a confirmation email started going out.
      return status === "PAID" ? "busy" : "already";
    });
    // A refund already made is found again by the next attempt, so trying again is safe.
    if (outcome === "busy") throw new HttpError(409, SENDING_CONFIRMATION);
    if (outcome === "cancelled") await notices.send(orderId);

    return {
      order: await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: orderFields }),
    };
  });
}
