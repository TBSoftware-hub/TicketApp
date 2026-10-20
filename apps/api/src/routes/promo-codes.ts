import { Prisma, type PrismaClient } from "@ticketapp/db";
import { createPromoCodeSchema, updatePromoCodeSchema } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { parse } from "../lib/validate";

const eventParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });
const promoParamsSchema = eventParamsSchema.extend({ promoCodeId: z.uuid() });

const promoFields = {
  id: true,
  code: true,
  discountType: true,
  discountValue: true,
  maxUses: true,
  validFrom: true,
  validUntil: true,
  active: true,
  ticketTypes: { select: { id: true }, orderBy: { createdAt: "asc" } },
  // Cancelled and refunded orders give their use back.
  _count: { select: { orders: { where: { status: { in: ["PENDING", "PAID"] } } } } },
  // Any order at all, cancelled ones included, keeps the code from being deleted.
  orders: { select: { id: true }, take: 1 },
} as const satisfies Prisma.PromoCodeSelect;

type PromoRow = Prisma.PromoCodeGetPayload<{ select: typeof promoFields }>;

function present({ ticketTypes, _count, orders, ...promo }: PromoRow) {
  return {
    ...promo,
    ticketTypeIds: ticketTypes.map((t) => t.id),
    uses: _count.orders,
    hasOrders: orders.length > 0,
  };
}

export async function promoCodeRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  async function requireEvent(orgId: string, eventId: string) {
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true },
    });
    if (!event) throw new HttpError(404, "Event not found");
  }

  // Codes are handed out selectively, so only people who manage events can list them.
  app.get("/orgs/:orgId/events/:eventId/promo-codes", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    await requireEvent(orgId, eventId);
    const promoCodes = await prisma.promoCode.findMany({
      where: { eventId },
      select: promoFields,
      orderBy: { createdAt: "asc" },
    });
    return { promoCodes: promoCodes.map(present) };
  });

  app.post("/orgs/:orgId/events/:eventId/promo-codes", async (request, reply) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const { ticketTypeIds = [], ...input } = parse(createPromoCodeSchema, request.body);
    await requireEvent(orgId, eventId);
    const ids = [...new Set(ticketTypeIds)];
    try {
      const promo = await prisma.$transaction(async (tx) => {
        // Locking the types keeps them from being deleted out from under the new code.
        const found = ids.length
          ? await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM "TicketType"
              WHERE id = ANY(${ids}::uuid[]) AND "eventId" = ${eventId}::uuid
              FOR SHARE`
          : [];
        if (found.length !== ids.length)
          throw new HttpError(400, "Pick ticket types from this event");
        return tx.promoCode.create({
          data: { ...input, eventId, ticketTypes: { connect: ids.map((id) => ({ id })) } },
          select: promoFields,
        });
      });
      return reply.code(201).send({ promoCode: present(promo) });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(409, "This event already has that code");
      }
      throw err;
    }
  });

  app.patch("/orgs/:orgId/events/:eventId/promo-codes/:promoCodeId", async (request) => {
    const { orgId, eventId, promoCodeId } = parse(promoParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const input = parse(updatePromoCodeSchema, request.body);
    const { count } = await prisma.promoCode.updateMany({
      where: { id: promoCodeId, eventId, event: { organizationId: orgId } },
      data: input,
    });
    if (count === 0) throw new HttpError(404, "Promo code not found");
    const promo = await prisma.promoCode.findUniqueOrThrow({
      where: { id: promoCodeId },
      select: promoFields,
    });
    return { promoCode: present(promo) };
  });

  app.delete("/orgs/:orgId/events/:eventId/promo-codes/:promoCodeId", async (request, reply) => {
    const { orgId, eventId, promoCodeId } = parse(promoParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const { count } = await prisma.promoCode
      .deleteMany({ where: { id: promoCodeId, eventId, event: { organizationId: orgId } } })
      .catch((err: unknown) => {
        // Orders keep the code they used (onDelete: Restrict); turn it off instead.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
          throw new HttpError(409, "Orders have used this code, so turn it off instead");
        }
        throw err;
      });
    if (count === 0) throw new HttpError(404, "Promo code not found");
    return reply.code(204).send();
  });
}
