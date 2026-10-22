import type { Prisma, PrismaClient } from "@ticketapp/db";
import {
  attendeeExportSchema,
  attendeeSearchSchema,
  formatPhone,
  type AttendeeCheckInFilter,
  type AttendeeSearch,
  type AttendeeWaiverFilter,
} from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { csvFile, localTime } from "../lib/csv";
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
  // Judged by what the ticket type asked for when the ticket was issued, not what it asks now.
  missing: { waiversRequired: true, signatures: { none: { signerRole: "ATTENDEE" } } },
  none: { waiversRequired: false, signatures: { none: { signerRole: "ATTENDEE" } } },
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
  ticketType: { select: { id: true, name: true } },
  waiversRequired: true,
  order: { select: { buyerName: true } },
  isInside: true,
  signatures: { where: { signerRole: "ATTENDEE" }, select: { id: true }, take: 1 },
  guardianRequest: { select: { signedAt: true, guardian: { select: { name: true } } } },
  // Whether they ever got in, by the same test the filters use.
  _count: { select: { scans: { where: admittingScan } } },
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
  return t.waiversRequired ? "missing" : "none";
}

function checkInStatus(t: AttendeeTicket): AttendeeCheckInFilter {
  if (t.isInside) return "inside";
  return t._count.scans > 0 ? "left" : "not-arrived";
}

/**
 * When they went in, for someone inside, or out, for someone who left. Null when the latest door
 * scan doesn't match, such as someone marked out with no check-out scan recorded.
 */
function checkInAt(t: AttendeeTicket, status: AttendeeCheckInFilter) {
  const last = t.scans[0];
  if (status === "inside" && last?.direction === "IN") return last.scannedAt;
  if (status === "left" && last?.direction === "OUT") return last.scannedAt;
  return null;
}

/** Tickets that will get someone in: not held for an unpaid checkout, cancelled or refunded. */
function comingTo(eventId: string) {
  return {
    eventId,
    status: "VALID",
    order: { status: "PAID" },
  } as const satisfies Prisma.TicketWhereInput;
}

/** The tickets a search and its filters pick out, for the list and the download alike. */
function matching(eventId: string, { q, waiver, checkIn, ticketTypeId }: AttendeeSearch) {
  const contains = (value: string) => ({ contains: value, mode: "insensitive" as const });
  return {
    ...comingTo(eventId),
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
  } satisfies Prisma.TicketWhereInput;
}

const byName = [
  { attendee: { lastName: "asc" } },
  { attendee: { firstName: "asc" } },
  { id: "asc" },
] as const satisfies Prisma.TicketOrderByWithRelationInput[];

/** The download carries what the list shows, and what staff need to reach people. */
const exportFields = {
  ...attendeeFields,
  code: true,
  attendee: {
    select: {
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      grade: true,
      studentId: true,
      dateOfBirth: true,
      emergencyContactName: true,
      emergencyContactPhone: true,
      medicalNotes: true,
    },
  },
  order: {
    select: {
      buyerName: true,
      buyerEmail: true,
      buyerPhone: true,
      paymentMethod: true,
      totalCents: true,
      createdAt: true,
    },
  },
  guardianRequest: {
    select: {
      signedAt: true,
      guardian: { select: { name: true, email: true, phone: true } },
    },
  },
} as const satisfies Prisma.TicketSelect;

const WAIVER_TEXT: Record<AttendeeWaiverFilter, string> = {
  signed: "Signed",
  waiting: "Waiting on a guardian",
  missing: "Not signed",
  none: "Not needed",
};

const CHECK_IN_TEXT: Record<AttendeeCheckInFilter, string> = {
  inside: "Inside",
  left: "Checked out",
  "not-arrived": "Not arrived",
};

/** How the order was paid for, the way a bookkeeper would say it. */
function paidWith({ paymentMethod, totalCents }: { paymentMethod: string; totalCents: number }) {
  if (paymentMethod === "COMP") return "Comp";
  if (totalCents === 0) return "Free";
  return paymentMethod === "CASH" ? "Cash" : "Card";
}

/** Everyone coming to an event, one row per ticket, for staff to look people up. */
export async function attendeeRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.get("/orgs/:orgId/events/:eventId/attendees", async (request) => {
    const { orgId, eventId } = parse(paramsSchema, request.params);
    const search = parse(attendeeSearchSchema, request.query);
    // Door staff look people up too, so this follows check-in rather than event management.
    await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true },
    });
    if (!event) throw new HttpError(404, "Event not found");

    const coming = comingTo(eventId);
    const tickets = await prisma.ticket.findMany({
      where: matching(eventId, search),
      select: attendeeFields,
      orderBy: byName,
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
      attendees: tickets.slice(0, ATTENDEE_PAGE).map((t) => {
        const checkIn = checkInStatus(t);
        return {
          ticketId: t.id,
          firstName: t.attendee.firstName,
          lastName: t.attendee.lastName,
          email: t.attendee.email,
          grade: t.attendee.grade,
          ticketType: { id: t.ticketType.id, name: t.ticketType.name },
          buyerName: t.order.buyerName,
          waiver: waiverStatus(t),
          guardianName: t.guardianRequest?.guardian.name ?? null,
          checkIn,
          checkInAt: checkInAt(t, checkIn),
        };
      }),
      more: tickets.length > ATTENDEE_PAGE,
      totals: { attendees: total, signed, waiting, missing, inside, left },
      ticketTypes,
    };
  });

  // Everyone the list's search and filters pick out, with no page limit, to open in a spreadsheet.
  app.get("/orgs/:orgId/events/:eventId/attendees.csv", async (request, reply) => {
    const { orgId, eventId } = parse(paramsSchema, request.params);
    const { details, ...search } = parse(attendeeExportSchema, request.query);
    // Door staff take it to the door, the same as the list, so this follows check-in too.
    await requireOrgPermission(prisma, request, orgId, "checkin.scan");
    const event = await prisma.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { slug: true, organization: { select: { timezone: true } } },
    });
    if (!event) throw new HttpError(404, "Event not found");
    const tz = event.organization.timezone;
    const tickets = await prisma.ticket.findMany({
      where: matching(eventId, search),
      select: exportFields,
      orderBy: byName,
    });

    const phone = (p: string | null | undefined) => (p ? formatPhone(p) : null);
    const header = [
      "Last name",
      "First name",
      "Email",
      "Phone",
      "Grade",
      "Student ID",
      "Date of birth",
      "Ticket type",
      "Ticket code",
      "Bought by",
      "Buyer email",
      "Buyer phone",
      "Paid with",
      "Ordered at",
      "Waiver",
      "Parent or guardian",
      "Guardian contact",
      "Check-in",
      "Last in or out",
      ...(details ? ["Emergency contact", "Emergency phone", "Medical notes"] : []),
    ];
    const rows = tickets.map((t) => {
      const checkIn = checkInStatus(t);
      const guardian = t.guardianRequest?.guardian;
      return [
        t.attendee.lastName,
        t.attendee.firstName,
        t.attendee.email,
        phone(t.attendee.phone),
        t.attendee.grade,
        t.attendee.studentId,
        t.attendee.dateOfBirth?.toISOString().slice(0, 10),
        t.ticketType.name,
        t.code,
        t.order.buyerName,
        t.order.buyerEmail,
        phone(t.order.buyerPhone),
        paidWith(t.order),
        localTime(t.order.createdAt, tz),
        WAIVER_TEXT[waiverStatus(t)],
        guardian?.name,
        [guardian?.email, phone(guardian?.phone)].filter(Boolean).join(", "),
        CHECK_IN_TEXT[checkIn],
        localTime(checkInAt(t, checkIn), tz),
        ...(details
          ? [
              t.attendee.emergencyContactName,
              phone(t.attendee.emergencyContactPhone),
              t.attendee.medicalNotes,
            ]
          : []),
      ];
    });
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="${event.slug}-${details ? "attendees-with-medical" : "attendees"}.csv"`,
      )
      .header("cache-control", "private, no-store")
      .send(csvFile([header, ...rows]));
  });
}
