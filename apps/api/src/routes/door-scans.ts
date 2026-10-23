import { Prisma, type PrismaClient, type ScanOutcome } from "@ticketapp/db";
import {
  doorScanSchema,
  type DoorScanResult,
  type ScanInvalidReason,
  type ScanWaiverMissingReason,
} from "@ticketapp/shared";
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

/**
 * Why a ticket's waiver keeps its holder out, or null when it doesn't. Judged by what the ticket
 * type asked for when the ticket was issued, as the attendee list's waiver filter is.
 */
function waiverMissing(ticket: {
  waiversRequired: boolean;
  signatures: unknown[];
  guardianRequest: { signedAt: Date | null } | null;
}): ScanWaiverMissingReason | null {
  if (ticket.signatures.length === 0) return ticket.waiversRequired ? "not_signed" : null;
  return ticket.guardianRequest && !ticket.guardianRequest.signedAt ? "guardian_pending" : null;
}

/** The door app's scanner: one scan in, one answer out, and every scan kept on record. */
export async function doorScanRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.post("/orgs/:orgId/events/:eventId/scans", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    const { user } = await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const { scanKey, code, direction, overrideReason, override } = parse(
      doorScanSchema,
      request.body,
    );
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { status: true, endsAt: true, reentryAllowed: true },
    });
    if (!event) throw new HttpError(404, "Event not found");
    // The same events the door app's picker offers: a device left on an event that was cancelled
    // or has ended since can't keep letting people in.
    if (event.status === "CANCELLED") throw new HttpError(409, "This event was cancelled");
    if (event.status !== "PUBLISHED") throw new HttpError(409, "This event isn't published yet");
    if (event.endsAt <= new Date()) throw new HttpError(409, "This event has ended");

    return prisma
      .$transaction(async (tx): Promise<DoorScanResult> => {
        const scannedAt = new Date();
        const record = (
          ticketId: string | null,
          outcome: ScanOutcome,
          // Set when staff let them in despite the outcome; that counts as an admission.
          reason: string | null = null,
        ) =>
          tx.scanEvent.create({
            data: {
              eventId,
              ticketId,
              direction: direction === "in" ? "IN" : "OUT",
              outcome,
              overrideReason: reason,
              staffUserId: user.id,
              scannedAt,
              // Only a scan that moved someone in or out is ever replayed, so only those keep a key.
              scanKey:
                outcome === "ADMITTED" || outcome === "CHECKED_OUT" || reason !== null
                  ? scanKey
                  : null,
            },
          });
        // A retry of the scan that let them in or out, sent because its answer was lost, gets that
        // answer again: staff never saw the green, so "already checked in" would send the holder
        // away. A retry racing its original waits on the ticket's row, so it finds the scan too.
        const replayed = async (ticketId: string) => {
          const earlier = await tx.scanEvent.findUnique({
            where: { scanKey },
            select: { eventId: true, ticketId: true, staffUserId: true, direction: true },
          });
          if (!earlier) return false;
          if (
            earlier.ticketId !== ticketId ||
            earlier.eventId !== eventId.toLowerCase() ||
            earlier.staffUserId !== user.id ||
            earlier.direction !== (direction === "in" ? "IN" : "OUT")
          ) {
            throw new HttpError(409, "That scan was already recorded for another ticket");
          }
          return true;
        };
        /** When they last checked out, if they have. */
        const lastCheckOut = async (ticketId: string) =>
          (
            await tx.scanEvent.findFirst({
              where: { ticketId, direction: "OUT", outcome: "CHECKED_OUT" },
              orderBy: [{ scannedAt: "desc" }, { id: "desc" }],
              select: { scannedAt: true },
            })
          )?.scannedAt ?? null;

        // Postgres text can't hold a zero byte, and no ticket code has one: answer it before the
        // lookups, which would fail on it.
        if (code.includes("\u0000")) {
          await record(null, "INVALID_TICKET");
          return { outcome: "invalid_ticket", reason: "unknown" };
        }

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

        if (direction === "out") {
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
          // Someone inside is let out whatever has happened to their ticket since it got them in.
          // Only one of two devices checking out the same ticket at once records it.
          const { count } = await tx.ticket.updateMany({
            where: { id: ticket.id, isInside: true },
            data: { isInside: false },
          });
          if (count === 1 || (await replayed(ticket.id))) {
            if (count === 1) await record(ticket.id, "CHECKED_OUT");
            return {
              outcome: "checked_out",
              ticket: details,
              reentryAllowed: event.reentryAllowed,
            };
          }
          if (reason) {
            await record(ticket.id, "INVALID_TICKET");
            return { outcome: "invalid_ticket", reason };
          }
          await record(ticket.id, "NOT_INSIDE");
          return { outcome: "not_inside", ticket: details, leftAt: await lastCheckOut(ticket.id) };
        }

        if (reason) {
          await record(ticket.id, "INVALID_TICKET");
          return { outcome: "invalid_ticket", reason };
        }

        const { attendee, ticketType, isInside, ...waiver } = await tx.ticket.findUniqueOrThrow({
          where: { id: ticket.id },
          select: {
            attendee: { select: { firstName: true, lastName: true } },
            ticketType: { select: { name: true } },
            isInside: true,
            waiversRequired: true,
            signatures: { where: { signerRole: "ATTENDEE" }, select: { id: true }, take: 1 },
            guardianRequest: { select: { signedAt: true } },
          },
        });
        const details = {
          attendeeName: `${attendee.firstName} ${attendee.lastName}`,
          ticketTypeName: ticketType.name,
        };

        // Someone who checked out is coming back: the event's re-entry rule decides, and their
        // waiver isn't asked about again, since it got them in once already.
        const leftAt = isInside ? null : await lastCheckOut(ticket.id);
        if (leftAt && !event.reentryAllowed && !(overrideReason && override === "reentry_denied")) {
          await record(ticket.id, "REENTRY_DENIED");
          return { outcome: "reentry_denied", ticket: details, leftAt };
        }
        // Someone already inside is told so below, whatever their waiver says: they got in once.
        // A waiver signed since the override was asked for needs no override, so none is recorded.
        const missing = isInside || leftAt ? null : waiverMissing(waiver);
        if (missing && !(overrideReason && override === "waiver_missing")) {
          await record(ticket.id, "WAIVER_MISSING");
          return { outcome: "waiver_missing", ticket: details, reason: missing };
        }
        // The answer staff let them in past, if it still holds; one that has cleared since (re-entry
        // turned on, a waiver signed) needs no override, so none is recorded.
        const overridden =
          leftAt && !event.reentryAllowed ? "REENTRY_DENIED" : missing ? "WAIVER_MISSING" : null;

        // Only one of two devices scanning the same ticket at once gets to let them in; the other
        // waits on the row and then finds them already inside.
        const { count } = await tx.ticket.updateMany({
          where: { id: ticket.id, status: "VALID", isInside: false },
          data: { isInside: true },
        });
        if (count === 1) {
          if (overridden) await record(ticket.id, overridden, overrideReason ?? null);
          else await record(ticket.id, "ADMITTED");
          return { outcome: "admitted", ticket: details };
        }
        if (await replayed(ticket.id)) return { outcome: "admitted", ticket: details };
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
      })
      .catch((err: unknown) => {
        // The key already let a different ticket in, or is doing so right now.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new HttpError(409, "That scan was already recorded for another ticket");
        }
        throw err;
      });
  });
}
