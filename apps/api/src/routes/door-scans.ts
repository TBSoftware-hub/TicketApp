import type { PrismaClient } from "@ticketapp/db";
import { doorScanSchema, type DoorScanResult, type ScanInvalidReason } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { parse } from "../lib/validate";

const eventParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });

interface ScannedTicket {
  id: string;
  eventId: string;
  status: "HELD" | "VALID" | "VOID";
  orderStatus: "PENDING" | "PAID" | "REFUNDED" | "CANCELLED";
  transferred: boolean;
}

/** Why a ticket for this event won't get anyone in, or null when it will. */
function invalidReason(ticket: ScannedTicket): ScanInvalidReason | null {
  if (ticket.transferred) return "transferred";
  if (ticket.orderStatus === "CANCELLED" || ticket.orderStatus === "REFUNDED") return "cancelled";
  if (ticket.status === "VOID") return "cancelled";
  if (ticket.status === "HELD" || ticket.orderStatus !== "PAID") return "unpaid";
  return null;
}

/** The door app's scanner: one scan in, one answer out, and every scan kept on record. */
export async function doorScanRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.post("/orgs/:orgId/events/:eventId/scans", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    const { user } = await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const { scanKey, code } = parse(doorScanSchema, request.body);
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { status: true, endsAt: true },
    });
    if (!event) throw new HttpError(404, "Event not found");
    // The same events the door app's picker offers: a device left on an event that was cancelled
    // or has ended since can't keep letting people in.
    if (event.status === "CANCELLED") throw new HttpError(409, "This event was cancelled");
    if (event.status !== "PUBLISHED") throw new HttpError(409, "This event isn't published yet");
    if (event.endsAt <= new Date()) throw new HttpError(409, "This event has ended");

    return prisma.$transaction(async (tx): Promise<DoorScanResult> => {
      const scannedAt = new Date();
      const record = (
        ticketId: string | null,
        outcome: "ADMITTED" | "ALREADY_INSIDE" | "INVALID_TICKET",
      ) =>
        tx.scanEvent.create({
          data: {
            eventId,
            ticketId,
            direction: "IN",
            outcome,
            staffUserId: user.id,
            scannedAt,
            // Only an admission is ever replayed, so only an admission keeps its key.
            scanKey: outcome === "ADMITTED" ? scanKey : null,
          },
        });

      // Shares the order's lock with other scans but waits on a cancel or transfer, which take it
      // for update: a ticket can't be voided while it lets someone in, or moved once they're inside.
      // The ticket is read in a second statement, after the lock is held: a transfer changes ticket
      // rows but not the order's, so a read made while waiting would still see the old ticket.
      await tx.$queryRaw`
        SELECT o.id FROM "Order" o JOIN "Ticket" t ON t."orderId" = o.id
        WHERE t.code = ${code}
        FOR SHARE OF o`;
      const [ticket] = await tx.$queryRaw<ScannedTicket[]>`
        SELECT t.id, t."eventId", t.status::text AS status, o.status::text AS "orderStatus",
          EXISTS (SELECT 1 FROM "Ticket" n WHERE n."transferredFromId" = t.id) AS transferred
        FROM "Ticket" t JOIN "Order" o ON o.id = t."orderId"
        WHERE t.code = ${code}`;
      // A ticket for another event is left off this event's record, as an unknown code is.
      // Postgres hands UUIDs back in lowercase, whatever case they were sent in.
      if (!ticket || ticket.eventId !== eventId.toLowerCase()) {
        await record(null, "INVALID_TICKET");
        return { outcome: "invalid_ticket", reason: ticket ? "other_event" : "unknown" };
      }
      const reason = invalidReason(ticket);
      if (reason) {
        await record(ticket.id, "INVALID_TICKET");
        return { outcome: "invalid_ticket", reason };
      }

      const { attendee, ticketType } = await tx.ticket.findUniqueOrThrow({
        where: { id: ticket.id },
        select: {
          attendee: { select: { firstName: true, lastName: true } },
          ticketType: { select: { name: true } },
        },
      });
      const details = {
        attendeeName: `${attendee.firstName} ${attendee.lastName}`,
        ticketTypeName: ticketType.name,
      };

      // Only one of two devices scanning the same ticket at once gets to let them in; the other
      // waits on the row and then finds them already inside.
      const { count } = await tx.ticket.updateMany({
        where: { id: ticket.id, status: "VALID", isInside: false },
        data: { isInside: true },
      });
      if (count === 1) {
        await record(ticket.id, "ADMITTED");
        return { outcome: "admitted", ticket: details };
      }
      // A retry of the scan that let them in, sent because its answer was lost, gets that answer
      // again: staff never saw the green, so "already checked in" would send the holder away.
      // A retry racing its original waits on the row above, so it finds the admission here too.
      const earlier = await tx.scanEvent.findUnique({
        where: { scanKey },
        select: { eventId: true, ticketId: true, staffUserId: true },
      });
      if (earlier) {
        if (
          earlier.ticketId !== ticket.id ||
          earlier.eventId !== eventId.toLowerCase() ||
          earlier.staffUserId !== user.id
        ) {
          throw new HttpError(409, "That scan was already recorded for another ticket");
        }
        return { outcome: "admitted", ticket: details };
      }
      const admitted = await tx.scanEvent.findFirst({
        where: {
          ticketId: ticket.id,
          direction: "IN",
          OR: [{ outcome: "ADMITTED" }, { overrideReason: { not: null } }],
        },
        orderBy: [{ scannedAt: "desc" }, { id: "desc" }],
        select: { scannedAt: true },
      });
      await record(ticket.id, "ALREADY_INSIDE");
      return {
        outcome: "already_inside",
        ticket: details,
        admittedAt: admitted?.scannedAt ?? null,
      };
    });
  });
}
