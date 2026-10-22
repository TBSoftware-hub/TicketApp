import type { Prisma, PrismaClient } from "@ticketapp/db";
import { formatPhone } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { parse } from "../lib/validate";
import {
  ticketWaiverFields,
  waiverBundlePdf,
  waiverPdf,
  type SignedVersion,
} from "../lib/waiver-pdf";

const paramsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });
const csvQuerySchema = z.object({
  /** Adds emergency contacts and medical notes, which not every vendor should get. */
  details: z
    .enum(["1"])
    .optional()
    .transform((d) => d === "1"),
});

const exportFields = {
  ...ticketWaiverFields,
  code: true,
  attendee: {
    select: {
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      emergencyContactName: true,
      emergencyContactPhone: true,
      medicalNotes: true,
    },
  },
  ticketType: { select: { name: true, _count: { select: { waivers: true } } } },
  order: { select: { buyerName: true, buyerEmail: true } },
  guardianRequest: {
    select: {
      signedAt: true,
      emailDeliveredAt: true,
      textDeliveredAt: true,
      guardian: { select: { name: true, email: true, phone: true } },
    },
  },
} as const satisfies Prisma.TicketSelect;

type ExportTicket = Prisma.TicketGetPayload<{ select: typeof exportFields }>;

/**
 * The event's attendees whose tickets carry waivers: tickets that will get someone in (valid, on a
 * paid order) whose type asked for waivers when issued, or that have signatures anyway. Sorted as a vendor would
 * look someone up, by last name.
 */
async function loadExport(prisma: PrismaClient, orgId: string, eventId: string) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, organizationId: orgId },
    select: {
      name: true,
      slug: true,
      startsAt: true,
      organization: { select: { name: true, timezone: true } },
    },
  });
  if (!event) throw new HttpError(404, "Event not found");
  const tickets = await prisma.ticket.findMany({
    where: {
      eventId,
      status: "VALID",
      order: { status: "PAID" },
      OR: [{ waiversRequired: true }, { signatures: { some: {} } }],
    },
    select: exportFields,
    orderBy: [{ attendee: { lastName: "asc" } }, { attendee: { firstName: "asc" } }, { id: "asc" }],
  });
  return { event, tickets };
}

/**
 * The parent or guardian on a ticket: the name they signed with once they have, since it can
 * differ from the name the buyer gave when inviting them.
 */
function guardianName(t: ExportTicket) {
  const signed = t.signatures.find((s) => s.signerRole === "GUARDIAN");
  return signed?.signerName ?? t.guardianRequest?.guardian.name;
}

/** Where a ticket's waivers stand, in a few words. */
function waiverStatus(t: ExportTicket) {
  const attendeeSigned = t.signatures.some((s) => s.signerRole === "ATTENDEE");
  if (!attendeeSigned) return "Not signed";
  const request = t.guardianRequest;
  if (request && !request.signedAt) return `Waiting on ${request.guardian.name} to sign`;
  return request ? `Signed, with ${guardianName(t)} as parent or guardian` : "Signed";
}

/**
 * A CSV cell. Quoted when it needs to be, and a leading = + - @ is defused so a spreadsheet
 * doesn't run what an attendee typed as a formula.
 */
function cell(value: string | null | undefined) {
  let v = value ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** "2026-10-22 14:50", in the organization's time zone, which is how spreadsheets sort well. */
function localTime(instant: Date | null | undefined, timeZone: string) {
  if (!instant) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** A download name built from the event's slug, which is already safe in a header. */
function fileName(slug: string, suffix: string) {
  return `${slug}-${suffix}`;
}

/** Everything a vendor needs to know who signed what for an event, as a CSV and as one PDF. */
export async function waiverExportRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  app.get("/orgs/:orgId/events/:eventId/waivers.csv", async (request, reply) => {
    const { orgId, eventId } = parse(paramsSchema, request.params);
    const { details } = parse(csvQuerySchema, request.query);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const { event, tickets } = await loadExport(prisma, orgId, eventId);
    const tz = event.organization.timezone;

    const versions = await versionsFor(prisma, tickets);
    const title = (s: { waiverTemplateId: string; templateVersion: number }) =>
      versions.find(
        (v) => v.waiverTemplateId === s.waiverTemplateId && v.version === s.templateVersion,
      )?.title ?? "Waiver";

    const header = [
      "Last name",
      "First name",
      "Ticket type",
      "Ticket code",
      "Date of birth",
      "Waiver status",
      "Waivers signed",
      "Attendee signed",
      "Attendee signed at",
      "Parent or guardian",
      "Guardian contact",
      "Guardian signed at",
      "Bought by",
      "Buyer email",
      ...(details ? ["Emergency contact", "Emergency phone", "Medical notes"] : []),
    ];
    const rows = tickets.map((t) => {
      const attendee = t.signatures.filter((s) => s.signerRole === "ATTENDEE");
      const guardian = t.signatures.filter((s) => s.signerRole === "GUARDIAN");
      const request = t.guardianRequest;
      return [
        t.attendee.lastName,
        t.attendee.firstName,
        t.ticketType.name,
        t.code,
        t.attendee.dateOfBirth?.toISOString().slice(0, 10),
        waiverStatus(t),
        attendee.map((s) => `${title(s)} (v${s.templateVersion})`).join("; "),
        attendee[0]?.signerName,
        localTime(attendee[0]?.signedAt, tz),
        guardianName(t),
        [request?.guardian.email, request?.guardian.phone && formatPhone(request.guardian.phone)]
          .filter(Boolean)
          .join(", "),
        localTime(guardian[0]?.signedAt, tz),
        t.order.buyerName,
        t.order.buyerEmail,
        ...(details
          ? [
              t.attendee.emergencyContactName,
              t.attendee.emergencyContactPhone && formatPhone(t.attendee.emergencyContactPhone),
              t.attendee.medicalNotes,
            ]
          : []),
      ];
    });
    // CRLF line ends and a byte-order mark, so Excel reads it as UTF-8 on every platform.
    const csv = `\uFEFF${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="${fileName(event.slug, details ? "waivers-with-medical.csv" : "waivers.csv")}"`,
      )
      .header("cache-control", "private, no-store")
      .send(csv);
  });

  app.get("/orgs/:orgId/events/:eventId/waivers.pdf", async (request, reply) => {
    const { orgId, eventId } = parse(paramsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const { event, tickets } = await loadExport(prisma, orgId, eventId);
    const signed = tickets.filter((t) => t.signatures.length > 0);
    if (signed.length === 0)
      throw new HttpError(404, "Nobody has signed a waiver for this event yet");

    const versions = await versionsFor(prisma, signed);
    const now = new Date();
    const ticketPdfs: Uint8Array[] = [];
    for (const t of signed) ticketPdfs.push(await waiverPdf(t, versions, now, { answers: false }));
    const pdf = await waiverBundlePdf(
      event,
      tickets.map((t) => ({
        name: `${t.attendee.lastName}, ${t.attendee.firstName}`,
        ticketTypeName: t.ticketType.name,
        status: waiverStatus(t),
      })),
      ticketPdfs,
      now,
    );
    return reply
      .type("application/pdf")
      .header(
        "content-disposition",
        `attachment; filename="${fileName(event.slug, "waivers.pdf")}"`,
      )
      .header("cache-control", "private, no-store")
      .send(Buffer.from(pdf));
  });
}

/** The waiver wording behind every signature on these tickets, in one query. */
async function versionsFor(
  prisma: PrismaClient,
  tickets: ExportTicket[],
): Promise<SignedVersion[]> {
  const keys = new Map(
    tickets.flatMap((t) =>
      t.signatures.map((s) => [
        `${s.waiverTemplateId}:${s.templateVersion}`,
        { waiverTemplateId: s.waiverTemplateId, version: s.templateVersion },
      ]),
    ),
  );
  if (keys.size === 0) return [];
  return prisma.waiverTemplateVersion.findMany({
    where: { OR: [...keys.values()] },
    select: { waiverTemplateId: true, version: true, title: true, body: true, fields: true },
  });
}
