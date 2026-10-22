import type { Prisma, PrismaClient } from "@ticketapp/db";
import {
  attendeeSearchSchema,
  type AttendeeCheckInFilter,
  type AttendeeWaiverFilter,
} from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { parse } from "../lib/validate";

const paramsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });

/** How many attendees the list shows at once; a search or filter narrows it down. */
const ATTENDEE_PAGE = 200;

/** A scan that got someone through the door, on its own or with a staff override. */
const admittingScan = {
  direction: "IN",
  OR: [{ outcome: "ADMITTED" }, { overrideReason: { not: null } }],
} as const satisfies Prisma.ScanEventWhereInput;

const attendeeSigned = {
  signatures: { some: { signerRole: "ATTENDEE" } },
} as const satisfies Prisma.TicketWhereInput;

const waiverWhere: Record<AttendeeWaiverFilter, Prisma.TicketWhereInput> = {
  signed: {
    ...attendeeSigned,
    OR: [{ guardianRequest: { is: null } }, { guardianRequest: { signedAt: { not: null } } }],
  },
  waiting: { ...attendeeSigned, guardianRequest: { signedAt: null } },
  missing: {
    ticketType: { waivers: { some: {} } },
    signatures: { none: { signerRole: "ATTENDEE" } },
  },
  none: {
    ticketType: { waivers: { none: {} } },
    signatures: { none: { signerRole: "ATTENDEE" } },
  },
};

const checkInWhere: Record<AttendeeCheckInFilter, Prisma.TicketWhereInput> = {
  inside: { isInside: true },
  left: { isInside: false, scans: { some: admittingScan } },
  "not-arrived": { isInside: false, scans: { none: admittingScan } },
};

const attendeeFields = {
  id: true,
  attendee: {
    select: { firstName: true, lastName: true, email: true, grade: true },
  },
  ticketType: { select: { id: true, name: true, _count: { select: { waivers: true } } } },
  order: { select: { buyerName: true } },
  isInside: true,
  signatures: { where: { signerRole: "ATTENDEE" }, select: { id: true }, take: 1 },
  guardianRequest: { select: { signedAt: true, guardian: { select: { name: true } } } },
  // The last time they came in or went out, which is what door staff ask about.
  scans: {
    where: { OR: [admittingScan, { direction: "OUT", outcome: "CHECKED_OUT" }] },
    orderBy: [{ scannedAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { direction: true, scannedAt: true },
  },
} as const satisfies Prisma.TicketSelect;

type AttendeeTicket = Prisma.TicketGetPayload<{ select: typeof attendeeFields }>;

function waiverStatus(t: AttendeeTicket): AttendeeWaiverFilter {
  if (t.signatures.length > 0) return t.guardianRequest?.signedAt === null ? "waiting" : "signed";
  return t.ticketType._count.waivers > 0 ? "missing" : "none";
}

function checkInStatus(t: AttendeeTicket): AttendeeCheckInFilter {
  if (t.isInside) return "inside";
  return t.scans.length > 0 ? "left" : "not-arrived";
}

/** Everyone coming to an event, one row per ticket, for staff to look people up. */
export async function attendeeRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.get("/orgs/:orgId/events/:eventId/attendees", async (request) => {
    const { orgId, eventId } = parse(paramsSchema, request.params);
    const { q, waiver, checkIn, ticketTypeId } = parse(attendeeSearchSchema, request.query);
    // Door staff look people up too, so this follows check-in rather than event management.
    await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true },
    });
    if (!event) throw new HttpError(404, "Event not found");

    // Tickets that will get someone in: not held for an unpaid checkout, cancelled or refunded.
    const coming = {
      eventId,
      status: "VALID",
      order: { status: "PAID" },
    } as const satisfies Prisma.TicketWhereInput;
    const contains = (value: string) => ({ contains: value, mode: "insensitive" as const });
    const tickets = await prisma.ticket.findMany({
      where: {
        ...coming,
        ...(ticketTypeId ? { ticketTypeId } : {}),
        // Every word has to match somewhere, so "Sam Lee" finds Sam Lee.
        AND: [
          ...(q?.split(/\s+/) ?? []).map((word) => ({
            OR: [
              { attendee: { firstName: contains(word) } },
              { attendee: { lastName: contains(word) } },
              { attendee: { email: contains(word) } },
              { order: { buyerName: contains(word) } },
            ],
          })),
          ...(waiver ? [waiverWhere[waiver]] : []),
          ...(checkIn ? [checkInWhere[checkIn]] : []),
        ],
      },
      select: attendeeFields,
      orderBy: [
        { attendee: { lastName: "asc" } },
        { attendee: { firstName: "asc" } },
        { id: "asc" },
      ],
      take: ATTENDEE_PAGE + 1,
    });

    // Event-wide totals, whatever the filters, so staff see the whole picture at a glance.
    const count = (where: Prisma.TicketWhereInput) =>
      prisma.ticket.count({ where: { ...coming, ...where } });
    const [total, signed, waiting, missing, inside, left, ticketTypes] = await Promise.all([
      count({}),
      count(waiverWhere.signed),
      count(waiverWhere.waiting),
      count(waiverWhere.missing),
      count(checkInWhere.inside),
      count(checkInWhere.left),
      prisma.ticketType.findMany({
        where: { eventId },
        select: { id: true, name: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);

    return {
      attendees: tickets.slice(0, ATTENDEE_PAGE).map((t) => ({
        ticketId: t.id,
        firstName: t.attendee.firstName,
        lastName: t.attendee.lastName,
        email: t.attendee.email,
        grade: t.attendee.grade,
        ticketType: { id: t.ticketType.id, name: t.ticketType.name },
        buyerName: t.order.buyerName,
        waiver: waiverStatus(t),
        guardianName: t.guardianRequest?.guardian.name ?? null,
        checkIn: checkInStatus(t),
        lastScanAt: t.scans[0]?.scannedAt ?? null,
      })),
      more: tickets.length > ATTENDEE_PAGE,
      totals: { attendees: total, signed, waiting, missing, inside, left },
      ticketTypes,
    };
  });
}
