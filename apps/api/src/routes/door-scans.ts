import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type ScanOutcome } from "@ticketapp/db";
import {
  DOOR_LOOKUP_LIMIT,
  doorLookupSchema,
  doorScanSchema,
  OFFLINE_SCAN_AHEAD_MS,
  OFFLINE_SCAN_MAX_AGE_MS,
  type DoorList,
  type DoorLookupResult,
  type DoorScanResult,
  type ScanInvalidReason,
  type ScanWaiverMissingReason,
} from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { parse } from "../lib/validate";
import { attendeeFields, byName, checkInStatus, comingTo, waiverStatus } from "./attendees";

const eventParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });

interface ScannedTicket {
  id: string;
  eventId: string;
  status: "HELD" | "VALID" | "VOID";
  orderStatus: "PENDING" | "PAID" | "REFUNDED" | "CANCELLED";
  transferred: boolean;
}

/** Why a ticket for this event won't get anyone in, or null when it will. */
function invalidReason(
  ticket: Pick<ScannedTicket, "status" | "orderStatus" | "transferred">,
): ScanInvalidReason | null {
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

/**
 * The event a door device is working, if it's still one the door app's picker offers: a device
 * left on an event that was cancelled or has ended since can't keep letting people in. A scan made
 * offline counts if the event was still on when it was made, so one sent after the end still lands.
 */
async function openEvent(prisma: PrismaClient, orgId: string, eventId: string, at = new Date()) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, organizationId: orgId },
    select: { status: true, endsAt: true, reentryAllowed: true },
  });
  if (!event) throw new HttpError(404, "Event not found");
  if (event.status === "CANCELLED") throw new HttpError(409, "This event was cancelled");
  if (event.status !== "PUBLISHED") throw new HttpError(409, "This event isn't published yet");
  if (event.endsAt <= at) throw new HttpError(409, "This event has ended");
  return event;
}

/**
 * The door app's scanner: one scan in, one answer out, and every scan kept on record. Also finds
 * people by name, for a guest who can't show their QR code.
 */
export async function doorScanRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.post("/orgs/:orgId/events/:eventId/scans", async (request) => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    const { user } = await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const { scanKey, offlineAt, code, ticketId, direction, overrideReason, override } = parse(
      doorScanSchema,
      request.body,
    );
    const lookedUp = ticketId !== undefined;
    if (offlineAt) {
      const now = Date.now();
      if (offlineAt.getTime() > now + OFFLINE_SCAN_AHEAD_MS) {
        throw new HttpError(400, "This device's clock is ahead. Check its date and time.");
      }
      if (offlineAt.getTime() < now - OFFLINE_SCAN_MAX_AGE_MS) {
        throw new HttpError(400, "This scan was saved offline too long ago to send");
      }
    }
    const event = await openEvent(prisma, orgId, eventId, offlineAt);

    return prisma
      .$transaction(async (tx): Promise<DoorScanResult> => {
        const record = (
          ticketId: string | null,
          outcome: ScanOutcome,
          // Set when staff let them in despite the outcome; that counts as an admission.
          reason: string | null = null,
          // What a scan that didn't move them was told, for a retry to get again.
          answer: DoorScanResult | null = null,
        ) => {
          // A retry of a scan of a ticket gets its first answer, so it can't move them later on:
          // say a check-out that found them not inside, sent again once they're back in.
          const kept = ticketId !== null && answer !== null;
          return tx.scanEvent.create({
            data: {
              eventId,
              ticketId,
              direction: direction === "in" ? "IN" : "OUT",
              outcome,
              overrideReason: reason,
              lookedUp,
              staffUserId: user.id,
              // Taken when the scan is recorded, which for one that moves them in or out is while the
              // ticket's row is locked, so the record's order matches the order they happened in.
              scannedAt: new Date(),
              offlineAt: offlineAt ?? null,
              // A scan of a ticket is replayed to a retry, so it keeps its key.
              scanKey:
                outcome === "ADMITTED" || outcome === "CHECKED_OUT" || reason !== null || kept
                  ? scanKey
                  : null,
              answer: kept ? (JSON.parse(JSON.stringify(answer)) as object) : undefined,
            },
          });
        };
        // A retry of the scan that let them in or out, sent because its answer was lost, gets that
        // answer again: staff never saw the green, so "already checked in" would send the holder
        // away. A retry racing its original waits on the ticket's row lock, so it finds the scan too.
        const replayed = async (ticketId: string) => {
          const earlier = await tx.scanEvent.findUnique({
            where: { scanKey },
            select: {
              eventId: true,
              ticketId: true,
              staffUserId: true,
              direction: true,
              answer: true,
            },
          });
          if (!earlier) return null;
          if (
            earlier.ticketId !== ticketId ||
            earlier.eventId !== eventId.toLowerCase() ||
            earlier.staffUserId !== user.id ||
            earlier.direction !== (direction === "in" ? "IN" : "OUT")
          ) {
            throw new HttpError(409, "That scan was already recorded for another ticket");
          }
          return { answer: earlier.answer as DoorScanResult | null };
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
        if (code?.includes("\u0000")) {
          await record(null, "INVALID_TICKET");
          return { outcome: "invalid_ticket", reason: "unknown" };
        }
        // Someone found by name goes through the same checks as their QR code would. A ticket's
        // code never changes, so it's safe to read before the locks below.
        const ticketCode =
          code ??
          (await tx.ticket.findUnique({ where: { id: ticketId }, select: { code: true } }))?.code;
        if (!ticketCode) {
          await record(null, "INVALID_TICKET");
          return { outcome: "invalid_ticket", reason: "unknown" };
        }

        // Shares the order's lock with other scans but waits on a cancel or transfer, which take it
        // for update: a ticket can't be voided while it lets someone in, or moved once they're inside.
        // The ticket is read in a second statement, after the lock is held: a transfer changes ticket
        // rows but not the order's, so a read made while waiting would still see the old ticket.
        await tx.$queryRaw`
        SELECT o.id FROM "Order" o JOIN "Ticket" t ON t."orderId" = o.id
        WHERE t.code = ${ticketCode}
        FOR SHARE OF o`;
        const [ticket] = await tx.$queryRaw<ScannedTicket[]>`
        SELECT t.id, t."eventId", t.status::text AS status, o.status::text AS "orderStatus",
          EXISTS (SELECT 1 FROM "Ticket" n WHERE n."transferredFromId" = t.id) AS transferred
        FROM "Ticket" t JOIN "Order" o ON o.id = t."orderId"
        WHERE t.code = ${ticketCode}`;
        // A ticket for another event is left off this event's record, as an unknown code is.
        // Postgres hands UUIDs back in lowercase, whatever case they were sent in.
        if (!ticket || ticket.eventId !== eventId.toLowerCase()) {
          await record(null, "INVALID_TICKET");
          return { outcome: "invalid_ticket", reason: ticket ? "other_event" : "unknown" };
        }
        // Scans of the same ticket take turns from here, so whether they're inside, whether they
        // left, and what that lets them do can't change under a scan that's deciding.
        await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${ticket.id}::uuid FOR UPDATE`;
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
        const checkedOut = {
          outcome: "checked_out",
          ticket: details,
          reentryAllowed: event.reentryAllowed,
        } as const;
        // A retry gets its first answer whatever has happened since, such as them going back out.
        const earlier = await replayed(ticket.id);
        if (earlier) {
          if (earlier.answer) return earlier.answer;
          return direction === "in" ? { outcome: "admitted", ticket: details } : checkedOut;
        }
        const reason = invalidReason(ticket);

        if (direction === "out") {
          // Someone inside is let out whatever has happened to their ticket since it got them in.
          if (isInside) {
            await tx.ticket.update({ where: { id: ticket.id }, data: { isInside: false } });
            await record(ticket.id, "CHECKED_OUT");
            return checkedOut;
          }
          if (reason) {
            const answer = { outcome: "invalid_ticket", reason } as const;
            await record(ticket.id, "INVALID_TICKET", null, answer);
            return answer;
          }
          const answer = {
            outcome: "not_inside",
            ticket: details,
            leftAt: await lastCheckOut(ticket.id),
          } as const;
          await record(ticket.id, "NOT_INSIDE", null, answer);
          return answer;
        }

        if (reason) {
          const answer = { outcome: "invalid_ticket", reason } as const;
          await record(ticket.id, "INVALID_TICKET", null, answer);
          return answer;
        }

        // Someone who checked out is coming back: the event's re-entry rule decides, and their
        // waiver isn't asked about again, since it got them in once already.
        const leftAt = isInside ? null : await lastCheckOut(ticket.id);
        if (leftAt && !event.reentryAllowed && !(overrideReason && override === "reentry_denied")) {
          const answer = { outcome: "reentry_denied", ticket: details, leftAt } as const;
          await record(ticket.id, "REENTRY_DENIED", null, answer);
          return answer;
        }
        // Someone already inside is told so below, whatever their waiver says: they got in once.
        // A waiver signed since the override was asked for needs no override, so none is recorded.
        const missing = isInside || leftAt ? null : waiverMissing(waiver);
        if (missing && !(overrideReason && override === "waiver_missing")) {
          const answer = { outcome: "waiver_missing", ticket: details, reason: missing } as const;
          await record(ticket.id, "WAIVER_MISSING", null, answer);
          return answer;
        }
        // The answer staff let them in past, if it still holds; one that has cleared since (re-entry
        // turned on, a waiver signed) needs no override, so none is recorded.
        const overridden =
          leftAt && !event.reentryAllowed ? "REENTRY_DENIED" : missing ? "WAIVER_MISSING" : null;

        // Only one of two devices scanning the same ticket at once gets to let them in; the other
        // waits on the row lock above and then finds them already inside.
        if (!isInside) {
          await tx.ticket.update({ where: { id: ticket.id }, data: { isInside: true } });
          if (overridden) await record(ticket.id, overridden, overrideReason ?? null);
          else await record(ticket.id, "ADMITTED");
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
        const answer = {
          outcome: "already_inside",
          ticket: details,
          admittedAt: admitted?.scannedAt ?? null,
        } as const;
        await record(ticket.id, "ALREADY_INSIDE", null, answer);
        return answer;
      })
      .catch((err: unknown) => {
        // The key already let a different ticket in, or is doing so right now.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new HttpError(409, "That scan was already recorded for another ticket");
        }
        throw err;
      });
  });

  // The list a door device saves for when it loses its connection: the same people a lookup can
  // find, with where each stands, and each ticket's code hashed so the device can match a scan.
  // Someone inside on a ticket voided since is listed too, marked invalid, so they can check out.
  app.get("/orgs/:orgId/events/:eventId/door-list", async (request): Promise<DoorList> => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const { reentryAllowed } = await openEvent(prisma, orgId, eventId);
    const fetchedAt = new Date();
    // One snapshot for both reads, so someone checked out between them can't show as having left
    // with no time they left, which would let them back in at an event without re-entry.
    const [tickets, checkOuts] = await prisma.$transaction(
      [
        prisma.ticket.findMany({
          where: { OR: [comingTo(eventId), { eventId, isInside: true }] },
          orderBy: byName,
          select: {
            ...attendeeFields,
            code: true,
            status: true,
            order: { select: { buyerName: true, status: true } },
            transferredTo: { select: { id: true } },
          },
        }),
        // When each person last checked out, which keeps them out at an event without re-entry.
        prisma.scanEvent.groupBy({
          by: ["ticketId"],
          where: { eventId, direction: "OUT", outcome: "CHECKED_OUT" },
          _max: { scannedAt: true },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const leftAt = new Map(checkOuts.map((c) => [c.ticketId, c._max.scannedAt]));
    return {
      reentryAllowed,
      fetchedAt,
      tickets: tickets.map((t) => ({
        ticketId: t.id,
        firstName: t.attendee.firstName,
        lastName: t.attendee.lastName,
        attendeeName: `${t.attendee.firstName} ${t.attendee.lastName}`,
        ticketTypeName: t.ticketType.name,
        grade: t.attendee.grade,
        codeHash: createHash("sha256").update(t.code).digest("hex"),
        checkIn: checkInStatus(t),
        waiver: waiverStatus(t),
        leftAt: leftAt.get(t.id) ?? null,
        invalid: invalidReason({
          status: t.status,
          orderStatus: t.order.status,
          transferred: t.transferredTo !== null,
        }),
      })),
    };
  });

  // Only tickets that can get someone in are listed: someone whose ticket was cancelled or moved
  // to another person isn't coming, and the person it moved to is listed under their own name.
  app.get("/orgs/:orgId/events/:eventId/lookup", async (request): Promise<DoorLookupResult> => {
    const { orgId, eventId } = parse(eventParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const { q } = parse(doorLookupSchema, request.query);
    await openEvent(prisma, orgId, eventId);
    const contains = (value: string) => ({ contains: value, mode: "insensitive" as const });
    const found = await prisma.ticket.findMany({
      where: {
        ...comingTo(eventId),
        // Every word has to match their first or last name, so "sam le" finds Sam Lee.
        AND: q.split(/\s+/).map((word) => ({
          OR: [
            { attendee: { firstName: contains(word) } },
            { attendee: { lastName: contains(word) } },
          ],
        })),
      },
      orderBy: byName,
      // One more than is shown, to tell whether there are more.
      take: DOOR_LOOKUP_LIMIT + 1,
      select: attendeeFields,
    });
    return {
      tickets: found.slice(0, DOOR_LOOKUP_LIMIT).map((t) => ({
        ticketId: t.id,
        attendeeName: `${t.attendee.firstName} ${t.attendee.lastName}`,
        ticketTypeName: t.ticketType.name,
        grade: t.attendee.grade,
        checkIn: checkInStatus(t),
        waiver: waiverStatus(t),
      })),
      more: found.length > DOOR_LOOKUP_LIMIT,
    };
  });
}
