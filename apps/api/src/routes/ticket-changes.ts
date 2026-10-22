import { Prisma, type PrismaClient } from "@ticketapp/db";
import {
  checkEligibility,
  editAttendeeSchema,
  emergencyInfoSchema,
  resendOrderSchema,
  sameName,
  transferTicketSchema,
} from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import {
  MAX_CONFIRMATION_ATTEMPTS,
  confirmationEmail,
  notSendingConfirmation,
  orderLink,
} from "../lib/confirmations";
import { HttpError } from "../lib/errors";
import { sendingGuardianRequest } from "../lib/guardian-requests";
import type { Mailer } from "../lib/mailer";
import { takesSeat } from "../lib/seats";
import { generateToken, hashToken } from "../lib/tokens";
import { parse } from "../lib/validate";
import { newTicketCode } from "./comps";
import { SENDING_CONFIRMATION, SENDING_GUARDIAN_LINK } from "./orders";

const ticketParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid(), ticketId: z.uuid() });
const orderParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid(), orderId: z.uuid() });

const NOT_VALID = "This ticket has been cancelled or given to someone else";

/** What an emailed ticket needs from its event. */
const emailEventFields = {
  name: true,
  slug: true,
  startsAt: true,
  endsAt: true,
  venue: true,
  organization: { select: { name: true, slug: true, timezone: true } },
} as const satisfies Prisma.EventSelect;

const emailTicketFields = {
  code: true,
  ticketType: { select: { name: true } },
  attendee: { select: { firstName: true, lastName: true } },
} as const satisfies Prisma.TicketSelect;

/** The emergency info a ticket type asks for, checked the way checkout checks it. */
function emergencyFields(asks: boolean, emergency: unknown, firstName: string) {
  if (!asks) return {};
  if (emergency == null) throw new HttpError(400, `Give an emergency contact for ${firstName}`);
  const checked = emergencyInfoSchema.safeParse(emergency);
  if (!checked.success) throw new HttpError(400, checked.error.issues[0]!.message);
  return {
    emergencyContactName: checked.data.contactName,
    emergencyContactPhone: checked.data.contactPhone,
    medicalNotes: checked.data.medicalNotes ?? null,
  };
}

/**
 * Staff fixing a ticket after it's issued: correcting the attendee's details, giving the ticket
 * to someone else, or sending an order's tickets again.
 */
export async function ticketChangeRoutes(
  app: FastifyInstance,
  { prisma, mailer, webBaseUrl }: { prisma: PrismaClient; mailer: Mailer; webBaseUrl: string },
) {
  const findTicket = async (orgId: string, eventId: string, ticketId: string) => {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, eventId, event: { organizationId: orgId } },
      select: {
        status: true,
        attendeeId: true,
        attendee: { select: { studentId: true } },
        order: { select: { status: true } },
        ticketType: { select: { askEmergencyInfo: true, studentsOnly: true } },
      },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (ticket.status !== "VALID" || ticket.order.status !== "PAID") {
      throw new HttpError(409, NOT_VALID);
    }
    return ticket;
  };

  // Corrects the details on a ticket. The ticket and its QR code stay the same, so this is for
  // the same person; giving it to someone else is a transfer.
  app.patch("/orgs/:orgId/events/:eventId/tickets/:ticketId", async (request) => {
    const { orgId, eventId, ticketId } = parse(ticketParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const input = parse(editAttendeeSchema, request.body);
    const ticket = await findTicket(orgId, eventId, ticketId);
    // A ticket matched to a student on the roster stays with that student.
    const { studentId } = ticket.attendee;
    if (studentId && ticket.ticketType.studentsOnly) {
      const student = await prisma.rosterStudent.findUnique({
        where: { organizationId_studentId: { organizationId: orgId, studentId } },
        select: { lastName: true },
      });
      if (student && !sameName(student.lastName, input.lastName)) {
        throw new HttpError(
          400,
          `The school's roster has student ID ${studentId} under a different last name. To give this ticket to someone else, transfer it`,
        );
      }
    }
    const attendee = await prisma.attendee.update({
      where: { id: ticket.attendeeId },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        ...emergencyFields(ticket.ticketType.askEmergencyInfo, input.emergency, input.firstName),
      },
      select: {
        firstName: true,
        lastName: true,
        emergencyContactName: true,
        emergencyContactPhone: true,
        medicalNotes: true,
      },
    });
    return { attendee };
  });

  // Gives a ticket to someone else. The old ticket is voided, keeping any waivers signed for it,
  // and a new one with a new QR code is issued to the new attendee in the same order. The new
  // attendee hasn't signed anything, so waivers the ticket type asks for show as missing.
  app.post("/orgs/:orgId/events/:eventId/tickets/:ticketId/transfer", async (request, reply) => {
    const { orgId, eventId, ticketId } = parse(ticketParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const input = parse(transferTicketSchema, request.body);
    await findTicket(orgId, eventId, ticketId);

    const claimedAt = new Date();
    const issued = await prisma.$transaction(async (tx) => {
      // The lock cancelling takes, and that a guardian link's claim shares, so neither can
      // happen halfway through.
      const [order] = await tx.$queryRaw<
        {
          id: string;
          status: string;
          confirmationSentAt: Date | null;
          pendingEmail: boolean;
        }[]
      >`
        SELECT o.id, o.status, o."confirmationSentAt",
               o."confirmationEmail" IS NOT NULL AS "pendingEmail"
        FROM "Ticket" t JOIN "Order" o ON o.id = t."orderId"
        WHERE t.id = ${ticketId}::uuid AND t."eventId" = ${eventId}::uuid
        FOR UPDATE OF o`;
      if (!order) throw new HttpError(404, "Ticket not found");
      if ((await tx.order.count({ where: { id: order.id, NOT: notSendingConfirmation() } })) > 0) {
        throw new HttpError(409, SENDING_CONFIRMATION);
      }
      // An email waiting to be retried carries the old QR code, and a retry has to send it as is.
      if (!order.confirmationSentAt && order.pendingEmail) {
        throw new HttpError(
          409,
          "The confirmation email for this order hasn't gone out yet. Try again in a few minutes.",
        );
      }
      if (
        (await tx.guardianSignatureRequest.count({ where: sendingGuardianRequest(order.id) })) > 0
      ) {
        throw new HttpError(409, SENDING_GUARDIAN_LINK);
      }
      const old = await tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { status: true, isInside: true, ticketTypeId: true },
      });
      if (old.status !== "VALID" || order.status !== "PAID") throw new HttpError(409, NOT_VALID);
      if (old.isInside) {
        throw new HttpError(409, "This ticket's holder is at the event now, so it can't be moved");
      }
      // Taken before the type's lock, as checkout takes the event's before its types', so the two
      // can't each hold a lock the other is waiting for. Issuing the new ticket needs it anyway.
      const [event] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM "Event" WHERE id = ${eventId}::uuid FOR KEY SHARE`;
      if (event!.status === "CANCELLED") throw new HttpError(409, "This event is cancelled");

      // The lock checkout takes on a type before counting a student's tickets, then the roster's.
      const [type] = await tx.$queryRaw<
        {
          name: string;
          studentsOnly: boolean;
          minGrade: number | null;
          maxGrade: number | null;
          requiresApproval: boolean;
          askEmergencyInfo: boolean;
        }[]
      >`
        SELECT name, "studentsOnly", "minGrade", "maxGrade", "requiresApproval", "askEmergencyInfo"
        FROM "TicketType" WHERE id = ${old.ticketTypeId}::uuid
        FOR UPDATE`;
      const [rosterState] = await tx.$queryRaw<{ rosterImportedAt: Date | null }[]>`
        SELECT "rosterImportedAt" FROM "Organization" WHERE id = ${orgId}::uuid FOR KEY SHARE`;
      let grade = input.grade ?? null;
      let studentId: string | null = null;
      if (type!.studentsOnly && rosterState?.rosterImportedAt) {
        if (!input.studentId) throw new HttpError(400, `Enter ${input.firstName}'s student ID`);
        const student = await tx.rosterStudent.findUnique({
          where: {
            organizationId_studentId: { organizationId: orgId, studentId: input.studentId },
          },
          select: { studentId: true, lastName: true, grade: true },
        });
        if (!student || !sameName(student.lastName, input.lastName)) {
          throw new HttpError(
            400,
            `The school's roster doesn't have student ID ${input.studentId} with the last name ${input.lastName}. Check both and try again`,
          );
        }
        const already = await tx.ticket.count({
          where: {
            ...takesSeat,
            eventId,
            ticketTypeId: old.ticketTypeId,
            id: { not: ticketId },
            attendee: { studentId: student.studentId },
          },
        });
        if (already > 0) {
          throw new HttpError(
            409,
            `Student ID ${student.studentId} already has a ${type!.name} ticket`,
          );
        }
        if (student.grade === null && (type!.minGrade !== null || type!.maxGrade !== null)) {
          throw new HttpError(
            400,
            `The school's roster doesn't list ${input.firstName}'s grade, so ask the school to add it`,
          );
        }
        grade = student.grade;
        studentId = student.studentId;
      }
      // Staff are moving a ticket that was already approved, so approval isn't asked again.
      const eligibility = checkEligibility(
        { ...type!, requiresApproval: false },
        { isStudent: type!.studentsOnly, grade },
      );
      if (!eligibility.eligible) {
        throw new HttpError(400, `${eligibility.reason} (${input.firstName})`);
      }
      const emergency = emergencyFields(type!.askEmergencyInfo, input.emergency, input.firstName);
      const hasWaivers =
        (await tx.ticketTypeWaiver.count({ where: { ticketTypeId: old.ticketTypeId } })) > 0;

      // Voided first, so the new ticket takes the seat the old one gives back.
      await tx.ticket.update({ where: { id: ticketId }, data: { status: "VOID" } });
      const attendee = await tx.attendee.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          grade,
          studentId,
          ...emergency,
        },
      });
      // Claimed while the new ticket is emailed, as a confirmation claims its order, so the
      // ticket can't be cancelled or moved on while its QR code is on its way.
      if (input.email) {
        await tx.order.update({
          where: { id: order.id },
          data: { confirmationClaimedAt: claimedAt },
        });
      }
      return tx.ticket.create({
        data: {
          code: newTicketCode(),
          orderId: order.id,
          eventId,
          ticketTypeId: old.ticketTypeId,
          attendeeId: attendee.id,
          waiversRequired: hasWaivers,
        },
        select: { id: true, orderId: true },
      });
    });

    let emailed: boolean | null = null;
    if (input.email) {
      try {
        const ticket = await prisma.ticket.findUniqueOrThrow({
          where: { id: issued.id },
          select: { ...emailTicketFields, event: { select: emailEventFields } },
        });
        const { event, ...rest } = ticket;
        const message = await confirmationEmail({
          buyerName: ticket.attendee.firstName,
          buyerEmail: input.email,
          totalCents: 0,
          orderUrl: null,
          event,
          tickets: [rest],
        });
        await mailer.send({ ...message, idempotencyKey: `ticket-transfer-${issued.id}` });
        emailed = true;
      } catch (err) {
        request.log.error({ err, ticketId: issued.id }, "Couldn't email the transferred ticket");
        emailed = false;
      } finally {
        await prisma.order.updateMany({
          where: { id: issued.orderId, confirmationClaimedAt: claimedAt },
          data: { confirmationClaimedAt: null },
        });
      }
    }
    return reply.code(201).send({ ticket: { id: issued.id }, emailed });
  });

  // Sends an order's tickets again, to the buyer's email or a corrected one. The email carries a
  // new order link, and the old link stops working, since it may have gone to the wrong person.
  app.post("/orgs/:orgId/events/:eventId/orders/:orderId/resend", async (request) => {
    const { orgId, eventId, orderId } = parse(orderParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "events.manage");
    const { email } = parse(resendOrderSchema, request.body);
    const found = await prisma.order.findFirst({
      where: { id: orderId, eventId, event: { organizationId: orgId } },
      select: { status: true },
    });
    if (!found) throw new HttpError(404, "Order not found");
    if (found.status !== "PAID") throw new HttpError(409, "This order is cancelled");

    const key = generateToken();
    const claimedAt = new Date();
    // Claimed the way the confirmation email claims an order, so the two can't both send, and
    // cancelling waits for this to finish.
    const order = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: "PAID", ...notSendingConfirmation(claimedAt) },
        data: { confirmationClaimedAt: claimedAt, buyerEmail: email, viewKeyHash: hashToken(key) },
      });
      if (count === 0) {
        const { status } = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { status: true },
        });
        throw new HttpError(
          409,
          status === "PAID" ? SENDING_CONFIRMATION : "This order is cancelled",
        );
      }
      return tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          buyerName: true,
          totalCents: true,
          confirmationSentAt: true,
          confirmationAttempts: true,
          event: { select: emailEventFields },
          tickets: {
            where: { status: "VALID" },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: emailTicketFields,
          },
        },
      });
    });

    let sent = false;
    try {
      if (order.tickets.length === 0) throw new HttpError(409, "This order has no tickets to send");
      const message = await confirmationEmail({
        ...order,
        buyerEmail: email,
        orderUrl: orderLink(webBaseUrl, order.event, orderId, key),
      });
      try {
        await mailer.send({
          ...message,
          idempotencyKey: `order-resend-${orderId}-${hashToken(key)}`,
        });
      } catch (err) {
        request.log.error({ err, orderId }, "Couldn't resend the order's tickets");
        throw new HttpError(502, "The email couldn't be sent. Try again in a minute.");
      }
      sent = true;
    } finally {
      // What becomes of a confirmation that hadn't gone out yet. Its saved message has the old link
      // and maybe the old address, so it's never sent as it was.
      let unsent: Prisma.OrderUpdateManyMutationInput;
      if (order.confirmationSentAt) unsent = {};
      // The tickets reached the buyer, so it never needs to go out.
      else if (sent) unsent = { confirmationSentAt: new Date() };
      // Tried before, under an idempotency key the provider may keep for the old message and
      // refuse a new one under, so staff send it from here instead.
      else if (order.confirmationAttempts > 0) {
        unsent = { confirmationAttempts: MAX_CONFIRMATION_ATTEMPTS };
      }
      // Never tried, so the usual retries send it, to the new address with the new link.
      else unsent = { emailViewKey: key };
      await prisma.order.updateMany({
        where: { id: orderId, confirmationClaimedAt: claimedAt },
        data: {
          confirmationClaimedAt: null,
          emailViewKey: null,
          confirmationEmail: Prisma.DbNull,
          ...unsent,
        },
      });
    }
    return { sent: true, email };
  });
}
