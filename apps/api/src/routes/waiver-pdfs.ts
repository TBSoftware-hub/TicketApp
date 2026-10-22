import type { Prisma, PrismaClient } from "@ticketapp/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { hashToken } from "../lib/tokens";
import { parse } from "../lib/validate";
import { signedVersions, ticketWaiverFields, waiverPdf } from "../lib/waiver-pdf";

const staffParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid(), ticketId: z.uuid() });
const buyerParamsSchema = z.object({ orderId: z.uuid(), ticketId: z.uuid() });
const keySchema = z.object({ key: z.string().min(1).max(100) });

export const NO_WAIVERS = "This ticket has no signed waivers";

/** Sends a ticket's signed waivers as a PDF download, or 404s when there's nothing signed. */
export async function sendWaiverPdf(
  db: Prisma.TransactionClient,
  reply: FastifyReply,
  where: Prisma.TicketWhereInput,
) {
  const ticket = await db.ticket.findFirst({ where, select: ticketWaiverFields });
  if (!ticket) throw new HttpError(404, "Ticket not found");
  if (ticket.signatures.length === 0) throw new HttpError(404, NO_WAIVERS);
  const pdf = await waiverPdf(ticket, await signedVersions(db, ticket));
  const name = `${ticket.attendee.firstName}-${ticket.attendee.lastName}-waivers`
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-+/g, "-");
  return reply
    .type("application/pdf")
    .header("content-disposition", `attachment; filename="${name}.pdf"`)
    .header("cache-control", "private, no-store")
    .send(Buffer.from(pdf));
}

/** Signed-waiver PDFs, for staff from the dashboard and for buyers from their order page. */
export async function waiverPdfRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.get("/orgs/:orgId/events/:eventId/tickets/:ticketId/waivers.pdf", async (request, reply) => {
    const { orgId, eventId, ticketId } = parse(staffParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    return sendWaiverPdf(prisma, reply, {
      id: ticketId,
      eventId,
      event: { organizationId: orgId },
    });
  });

  // The order's private link key stands in for signing in, as it does for the order page.
  app.post("/public/orders/:orderId/tickets/:ticketId/waivers.pdf", async (request, reply) => {
    const { orderId, ticketId } = parse(buyerParamsSchema, request.params);
    const { key } = parse(keySchema, request.body);
    return sendWaiverPdf(prisma, reply, {
      id: ticketId,
      order: { id: orderId, viewKeyHash: hashToken(key) },
    });
  });
}
