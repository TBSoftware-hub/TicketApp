import { Prisma, type PrismaClient } from "@ticketapp/db";
import { guardianSignSchema, type WaiverField } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { waiverDocumentHash } from "../lib/canonical";
import { HttpError } from "../lib/errors";
import { hashToken } from "../lib/tokens";
import { parse } from "../lib/validate";
import { sendWaiverPdf } from "./waiver-pdfs";

const viewSchema = z.object({ token: z.string().min(1).max(100) });

const requestFields = {
  id: true,
  guardianId: true,
  signedAt: true,
  guardian: { select: { name: true } },
  ticket: {
    select: {
      id: true,
      status: true,
      attendee: { select: { firstName: true, lastName: true } },
      order: { select: { status: true, buyerName: true } },
      event: {
        select: {
          name: true,
          status: true,
          startsAt: true,
          endsAt: true,
          venue: true,
          organization: { select: { name: true, timezone: true } },
        },
      },
      signatures: {
        orderBy: { signedAt: "asc" },
        select: {
          waiverTemplateId: true,
          templateVersion: true,
          signerRole: true,
          signerName: true,
          answers: true,
        },
      },
    },
  },
} as const satisfies Prisma.GuardianSignatureRequestSelect;

type RequestRow = Prisma.GuardianSignatureRequestGetPayload<{ select: typeof requestFields }>;

const NOT_FOUND = "This link doesn't work. Ask whoever bought the ticket to check their order";

/**
 * The request a signing link points at, as long as its ticket still stands and its event isn't
 * over. Past that the link shows nothing, so it can't keep exposing the attendee's details.
 */
async function findRequest(db: Prisma.TransactionClient, token: string, now = new Date()) {
  // The first link, or one sent with a reminder; they all keep working.
  const tokenHash = hashToken(token);
  const request = await db.guardianSignatureRequest.findFirst({
    where: { OR: [{ tokenHash }, { links: { some: { tokenHash } } }] },
    select: requestFields,
  });
  if (!request || request.ticket.status !== "VALID" || request.ticket.order.status !== "PAID") {
    throw new HttpError(404, NOT_FOUND);
  }
  if (request.ticket.event.status === "CANCELLED") {
    throw new HttpError(
      410,
      `${request.ticket.event.name} was cancelled, so this link no longer works`,
    );
  }
  if (request.ticket.event.endsAt <= now) {
    throw new HttpError(410, `${request.ticket.event.name} is over, so this link no longer works`);
  }
  return request;
}

/**
 * The waivers the guardian signs: the ones the attendee signed at checkout that ask for a
 * guardian, in the exact version the attendee signed.
 */
async function waiversToSign(db: Prisma.TransactionClient, request: RequestRow) {
  const signed = request.ticket.signatures.filter((s) => s.signerRole === "ATTENDEE");
  const versions = await db.waiverTemplateVersion.findMany({
    where: {
      OR: signed.map((s) => ({ waiverTemplateId: s.waiverTemplateId, version: s.templateVersion })),
      requiresGuardianForMinors: true,
    },
    select: { waiverTemplateId: true, version: true, title: true, body: true, fields: true },
  });
  return signed.flatMap((s) => {
    const v = versions.find(
      (v) => v.waiverTemplateId === s.waiverTemplateId && v.version === s.templateVersion,
    );
    return v
      ? [
          {
            id: v.waiverTemplateId,
            version: v.version,
            title: v.title,
            body: v.body,
            fields: v.fields as WaiverField[],
            /** What the attendee answered, shown to the guardian alongside the wording. */
            answers: s.answers as Record<string, string | boolean>,
          },
        ]
      : [];
  });
}

async function present(db: Prisma.TransactionClient, request: RequestRow) {
  const { ticket } = request;
  const { name, startsAt, endsAt, venue, organization } = ticket.event;
  const guardianSignature = ticket.signatures.find((s) => s.signerRole === "GUARDIAN");
  return {
    request: {
      guardianName: request.guardian.name,
      buyerName: ticket.order.buyerName,
      attendee: ticket.attendee,
      event: {
        name,
        startsAt,
        endsAt,
        venue,
        organizationName: organization.name,
        timezone: organization.timezone,
      },
      waivers: await waiversToSign(db, request),
      signedAt: request.signedAt,
      signerName: request.signedAt ? (guardianSignature?.signerName ?? null) : null,
    },
  };
}

/** Where a minor's guardian reads and signs the waivers, from the link they were sent. */
export async function guardianSignatureRoutes(
  app: FastifyInstance,
  { prisma, signPerIpPerMinute }: { prisma: PrismaClient; signPerIpPerMinute: number },
) {
  app.post("/public/guardian-signatures/view", async (request) => {
    const { token } = parse(viewSchema, request.body);
    return present(prisma, await findRequest(prisma, token));
  });

  app.post(
    "/public/guardian-signatures/sign",
    { config: { rateLimit: { max: signPerIpPerMinute, timeWindow: "1 minute" } } },
    async (request) => {
      const input = parse(guardianSignSchema, request.body);
      return prisma.$transaction(async (tx) => {
        // Locked so two tabs signing at once can't both record a signature.
        const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT r.id FROM "GuardianSignatureRequest" r
          WHERE r."tokenHash" = ${hashToken(input.token)}
            OR EXISTS (
              SELECT 1 FROM "GuardianSignatureLink" l
              WHERE l."requestId" = r.id AND l."tokenHash" = ${hashToken(input.token)}
            )
          FOR UPDATE OF r`;
        if (!locked) throw new HttpError(404, NOT_FOUND);
        const now = new Date();
        const found = await findRequest(tx, input.token, now);
        if (found.signedAt) throw new HttpError(409, "These waivers are already signed");
        const waivers = await waiversToSign(tx, found);
        await tx.waiverSignature.createMany({
          data: waivers.map((w) => ({
            ticketId: found.ticket.id,
            waiverTemplateId: w.id,
            templateVersion: w.version,
            signerRole: "GUARDIAN" as const,
            signerName: input.signature,
            guardianId: found.guardianId,
            signedAt: now,
            ipAddress: request.ip,
            userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null,
            documentHash: waiverDocumentHash(w),
          })),
        });
        // Signed, so the link's messages have nothing left to ask for.
        await tx.guardianSignatureRequest.update({
          where: { id: found.id },
          data: { signedAt: now, pendingMessages: Prisma.DbNull },
        });
        return present(tx, await findRequest(tx, input.token, now));
      });
    },
  );

  // The guardian's copy of what was signed, for as long as their link works.
  app.post("/public/guardian-signatures/waivers.pdf", async (request, reply) => {
    const { token } = parse(viewSchema, request.body);
    const found = await findRequest(prisma, token);
    return sendWaiverPdf(prisma, reply, { id: found.ticket.id });
  });
}
