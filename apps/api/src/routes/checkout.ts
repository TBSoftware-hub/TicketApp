import type { Prisma, PrismaClient } from "@ticketapp/db";
import {
  checkEligibility,
  checkoutSchema,
  orderTotal,
  promoCodeProblem,
  promoDiscountCents,
  ticketSaleStatus,
} from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/errors";
import type { Payments } from "../lib/payments";
import { takesSeat } from "../lib/seats";
import { generateToken, hashToken } from "../lib/tokens";
import { parse } from "../lib/validate";
import { newTicketCode } from "./comps";

const slug = z.string().min(1).max(80);
const eventParamsSchema = z.object({ orgSlug: slug, eventSlug: slug });
const orderParamsSchema = z.object({ orderId: z.uuid() });
const orderBodySchema = z.object({ key: z.string().min(1).max(100) });

/** Stripe keeps a payment page open for at least 30 minutes; a minute more allows for clock skew. */
const CHECKOUT_MINUTES = 31;
/** Seats outlast the payment page a little, so someone paying at the last second keeps them. */
const HOLD_MINUTES = CHECKOUT_MINUTES + 5;

const orderFields = {
  id: true,
  status: true,
  buyerName: true,
  buyerEmail: true,
  subtotalCents: true,
  discountCents: true,
  feeCents: true,
  totalCents: true,
  event: {
    select: {
      name: true,
      slug: true,
      startsAt: true,
      endsAt: true,
      venue: true,
      organization: { select: { name: true, slug: true, timezone: true } },
    },
  },
  tickets: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      ticketType: { select: { name: true } },
      attendee: { select: { firstName: true, lastName: true } },
    },
  },
} as const satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderFields }>;

function present({ event, tickets, ...order }: OrderRow) {
  const { organization, ...rest } = event;
  return {
    ...order,
    event: {
      ...rest,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      timezone: organization.timezone,
    },
    tickets: tickets.map((t) => ({
      id: t.id,
      status: t.status,
      ticketTypeName: t.ticketType.name,
      firstName: t.attendee.firstName,
      lastName: t.attendee.lastName,
    })),
  };
}

/** Gives up an unpaid order's seats and its promo code use. */
async function releaseOrders(tx: Prisma.TransactionClient, orderIds: string[]) {
  if (orderIds.length === 0) return;
  await tx.ticket.updateMany({
    where: { orderId: { in: orderIds }, status: "HELD" },
    data: { status: "VOID" },
  });
  await tx.order.updateMany({
    where: { id: { in: orderIds }, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
}

/** Buying tickets. No sign-in: the buyer gets a private link to their order instead. */
export async function checkoutRoutes(
  app: FastifyInstance,
  {
    prisma,
    payments,
    webBaseUrl,
    checkoutPerIpPerMinute,
  }: {
    prisma: PrismaClient;
    payments?: Payments;
    webBaseUrl: string;
    checkoutPerIpPerMinute: number;
  },
) {
  // Every checkout holds seats for a while, so one client can't be let loose on them. The
  // checkout page calls this from the buyer's browser, so the limit is per buyer, not per server.
  const checkoutLimit = { rateLimit: { max: checkoutPerIpPerMinute, timeWindow: "1 minute" } };

  app.post(
    "/public/events/:orgSlug/:eventSlug/checkout",
    { config: checkoutLimit },
    async (request, reply) => {
      const { orgSlug, eventSlug } = parse(eventParamsSchema, request.params);
      const input = parse(checkoutSchema, request.body);
      const event = await prisma.event.findFirst({
        where: { slug: eventSlug, organization: { slug: orgSlug }, status: "PUBLISHED" },
        select: {
          id: true,
          name: true,
          organization: {
            select: {
              stripeAccountId: true,
              stripeChargesEnabled: true,
              stripeLivemode: true,
              cardFeePaidBy: true,
            },
          },
        },
      });
      if (!event) throw new HttpError(404, "Event not found");
      const org = event.organization;
      const accountId =
        payments &&
        org.stripeAccountId &&
        org.stripeChargesEnabled &&
        org.stripeLivemode === payments.livemode
          ? org.stripeAccountId
          : null;

      const now = new Date();
      const viewKey = generateToken();
      const counts = new Map<string, number>();
      for (const t of input.tickets)
        counts.set(t.ticketTypeId, (counts.get(t.ticketTypeId) ?? 0) + 1);
      const typeIds = [...counts.keys()];

      const order = await prisma.$transaction(async (tx) => {
        // The same lock comps take, so two buyers can't both get the last seat.
        const [locked] = await tx.$queryRaw<
          { capacity: number | null; status: string; endsAt: Date }[]
        >`
          SELECT capacity, status, "endsAt" FROM "Event" WHERE id = ${event.id}::uuid FOR UPDATE`;
        if (!locked || locked.status !== "PUBLISHED")
          throw new HttpError(409, "Tickets aren't on sale");

        // Holds that ran out give their seats and promo code uses back.
        const lapsed = await tx.order.findMany({
          where: { eventId: event.id, status: "PENDING", holdExpiresAt: { lte: now } },
          select: { id: true },
        });
        await releaseOrders(
          tx,
          lapsed.map((o) => o.id),
        );

        const types = await tx.$queryRaw<
          {
            id: string;
            name: string;
            priceCents: number;
            quantity: number | null;
            maxPerOrder: number;
            salesStartAt: Date | null;
            salesEndAt: Date | null;
            studentsOnly: boolean;
            minGrade: number | null;
            maxGrade: number | null;
            requiresApproval: boolean;
          }[]
        >`
          SELECT id, name, "priceCents", quantity, "maxPerOrder", "salesStartAt", "salesEndAt",
                 "studentsOnly", "minGrade", "maxGrade", "requiresApproval"
          FROM "TicketType"
          WHERE id = ANY(${typeIds}::uuid[]) AND "eventId" = ${event.id}::uuid
          FOR UPDATE`;
        if (types.length !== typeIds.length) {
          throw new HttpError(400, "Pick tickets from this event");
        }
        const byId = new Map(types.map((t) => [t.id, t]));

        const seats = takesSeat(now);
        const taken = await tx.ticket.count({ where: { eventId: event.id, ...seats } });
        const eventRemaining = locked.capacity === null ? null : locked.capacity - taken;
        for (const type of types) {
          const wanted = counts.get(type.id)!;
          if (type.requiresApproval) {
            throw new HttpError(
              400,
              `${type.name} tickets need the school's approval, so they can't be bought online yet`,
            );
          }
          const sold = await tx.ticket.count({ where: { ticketTypeId: type.id, ...seats } });
          const status = ticketSaleStatus(type, {
            sold,
            eventEndsAt: locked.endsAt,
            eventRemaining,
            now,
          });
          if (status === "soldOut") throw new HttpError(409, `${type.name} tickets are sold out`);
          if (status !== "onSale") throw new HttpError(409, `${type.name} tickets aren't on sale`);
          if (wanted > type.maxPerOrder) {
            throw new HttpError(
              400,
              `You can buy up to ${type.maxPerOrder} ${type.name} tickets per order`,
            );
          }
          if (type.quantity !== null && sold + wanted > type.quantity) {
            throw new HttpError(409, `Only ${type.quantity - sold} ${type.name} tickets are left`);
          }
        }
        if (eventRemaining !== null && input.tickets.length > eventRemaining) {
          throw new HttpError(409, `Only ${eventRemaining} tickets are left for this event`);
        }
        for (const ticket of input.tickets) {
          const type = byId.get(ticket.ticketTypeId)!;
          // Picking a students-only ticket is how the buyer says the attendee is a student.
          const eligibility = checkEligibility(type, {
            isStudent: type.studentsOnly,
            grade: ticket.grade ?? null,
          });
          if (!eligibility.eligible) {
            throw new HttpError(400, `${eligibility.reason} (${ticket.firstName})`);
          }
        }

        const lines = types.map((t) => ({
          ticketTypeId: t.id,
          unitCents: t.priceCents,
          quantity: counts.get(t.id)!,
        }));
        const subtotalCents = lines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0);
        let discountCents = 0;
        let promoCodeId: string | null = null;
        if (input.promoCode) {
          // Locked so two orders can't both take a code's last use.
          const [promo] = await tx.$queryRaw<
            {
              id: string;
              discountType: "PERCENT" | "AMOUNT";
              discountValue: number;
              maxUses: number | null;
              validFrom: Date | null;
              validUntil: Date | null;
              active: boolean;
            }[]
          >`
            SELECT id, "discountType", "discountValue", "maxUses", "validFrom", "validUntil", active
            FROM "PromoCode"
            WHERE "eventId" = ${event.id}::uuid AND code = ${input.promoCode}
            FOR UPDATE`;
          if (!promo) throw new HttpError(400, "That code doesn't work for this event");
          const scope = await tx.promoCode.findUniqueOrThrow({
            where: { id: promo.id },
            select: { ticketTypes: { select: { id: true } } },
          });
          const rules = { ...promo, ticketTypeIds: scope.ticketTypes.map((t) => t.id) };
          const uses = await tx.order.count({
            where: { promoCodeId: promo.id, status: { in: ["PENDING", "PAID"] } },
          });
          const problem = promoCodeProblem(rules, { uses, now });
          if (problem) throw new HttpError(400, problem);
          discountCents = promoDiscountCents(rules, lines);
          if (discountCents === 0) {
            throw new HttpError(400, "That code doesn't apply to these tickets");
          }
          promoCodeId = promo.id;
        }

        const totals = orderTotal(subtotalCents - discountCents, org.cardFeePaidBy);
        const free = totals.totalCents === 0;
        if (!free && !accountId) {
          throw new HttpError(409, "This event isn't taking card payments yet");
        }
        return tx.order.create({
          data: {
            event: { connect: { id: event.id } },
            buyerName: input.buyerName,
            buyerEmail: input.buyerEmail,
            buyerPhone: input.buyerPhone || null,
            status: free ? "PAID" : "PENDING",
            paymentMethod: "CARD",
            subtotalCents,
            discountCents,
            ...(promoCodeId ? { promoCode: { connect: { id: promoCodeId } } } : {}),
            ...totals,
            viewKeyHash: hashToken(viewKey),
            holdExpiresAt: free ? null : new Date(now.getTime() + HOLD_MINUTES * 60_000),
            tickets: {
              create: input.tickets.map((t) => ({
                code: newTicketCode(),
                status: free ? ("VALID" as const) : ("HELD" as const),
                event: { connect: { id: event.id } },
                ticketType: { connect: { id: t.ticketTypeId } },
                attendee: {
                  create: { firstName: t.firstName, lastName: t.lastName, grade: t.grade ?? null },
                },
              })),
            },
          },
          select: { id: true, totalCents: true, feeCents: true, processingFeeCents: true },
        });
      });

      if (order.totalCents === 0) {
        return reply.code(201).send({ orderId: order.id, key: viewKey, paymentUrl: null });
      }

      const eventPath = `${webBaseUrl}/e/${encodeURIComponent(orgSlug)}/${encodeURIComponent(eventSlug)}`;
      let session: { id: string; url: string };
      try {
        session = await payments!.createCheckout({
          accountId: accountId!,
          orderId: order.id,
          lines: [
            {
              name: `${event.name}: ${input.tickets.length} ${input.tickets.length === 1 ? "ticket" : "tickets"}`,
              amountCents: order.totalCents - order.feeCents,
            },
            ...(order.feeCents > 0
              ? [{ name: "Card processing fee", amountCents: order.feeCents }]
              : []),
          ],
          applicationFeeCents: order.processingFeeCents,
          buyerEmail: input.buyerEmail,
          successUrl: `${eventPath}/orders/${order.id}?key=${viewKey}`,
          cancelUrl: `${eventPath}/checkout?cancelled=1`,
          expiresAt: new Date(Date.now() + CHECKOUT_MINUTES * 60_000),
        });
      } catch (err) {
        // Without a payment page nobody can pay for the held seats, so let them go now.
        await prisma.$transaction((tx) => releaseOrders(tx, [order.id]));
        throw err;
      }
      await prisma.order.update({
        where: { id: order.id },
        data: { stripeCheckoutSessionId: session.id },
      });
      return reply.code(201).send({ orderId: order.id, key: viewKey, paymentUrl: session.url });
    },
  );

  // Where Stripe sends the buyer back. Also settles the order, until webhooks (E4.6) do it too.
  app.post("/public/orders/:orderId", async (request) => {
    const { orderId } = parse(orderParamsSchema, request.params);
    const { key } = parse(orderBodySchema, request.body);
    const where = { id: orderId, viewKeyHash: hashToken(key) };
    const found = await prisma.order.findFirst({
      where,
      select: { status: true, stripeCheckoutSessionId: true },
    });
    if (!found) throw new HttpError(404, "Order not found");

    // A cancelled order with a payment page may have lapsed while the buyer was still paying.
    const unsettled = found.status === "PENDING" || found.status === "CANCELLED";
    const sessionId = found.stripeCheckoutSessionId;
    const state =
      unsettled && sessionId && payments ? await payments.checkoutState(sessionId) : null;
    if (state?.status === "paid") {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.order.updateMany({
          where: { id: orderId, status: { in: ["PENDING", "CANCELLED"] } },
          data: {
            status: "PAID",
            stripePaymentIntentId: state.paymentIntentId,
            holdExpiresAt: null,
          },
        });
        // They paid, so they get their tickets even if the hold had run out.
        if (count > 0) {
          await tx.ticket.updateMany({
            where: { orderId, status: { in: ["HELD", "VOID"] } },
            data: { status: "VALID" },
          });
        }
      });
    } else if (state?.status === "expired") {
      await prisma.$transaction((tx) => releaseOrders(tx, [orderId]));
    }
    const settled = await prisma.order.findFirstOrThrow({ where, select: orderFields });
    return { order: present(settled) };
  });
}
