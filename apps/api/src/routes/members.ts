import type { PrismaClient } from "@ticketapp/db";
import {
  acceptInvitationSchema,
  createInvitationSchema,
  INVITATION_TTL_DAYS,
  invitationTokenSchema,
  roleCan,
} from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission, SESSION_TTL_MS } from "../lib/auth";
import { HttpError } from "../lib/errors";
import type { Mailer } from "../lib/mailer";
import { sendOrFail } from "../lib/send";
import { generateToken, hashToken } from "../lib/tokens";
import { parse } from "../lib/validate";

const orgParamsSchema = z.object({ orgId: z.uuid() });
const invitationParamsSchema = orgParamsSchema.extend({ invitationId: z.uuid() });

const ROLE_NAMES = {
  OWNER: "an owner",
  ADMIN: "an admin",
  DOOR_STAFF: "door staff",
  VIEWER: "a viewer",
};

// Invitations send email to addresses the sender chooses, so cap how many a person can send and
// how many any one address receives.
const INVITES_PER_SENDER_PER_HOUR = 30;
const INVITES_PER_RECIPIENT_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;

const openInvitation = (now: Date) => ({
  acceptedAt: null,
  revokedAt: null,
  expiresAt: { gt: now },
});

export interface MemberRouteOptions {
  prisma: PrismaClient;
  mailer: Mailer;
  webBaseUrl: string;
}

export async function memberRoutes(
  app: FastifyInstance,
  { prisma, mailer, webBaseUrl }: MemberRouteOptions,
) {
  app.get("/orgs/:orgId/members", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    const { role } = await requireOrgPermission(prisma, request, orgId, "org.view");
    const memberships = await prisma.membership.findMany({
      where: { organizationId: orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
    // Pending invitations are only shown to people who can manage the team.
    const invitations = roleCan(role, "members.manage")
      ? await prisma.invitation.findMany({
          where: { organizationId: orgId, ...openInvitation(new Date()) },
          select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    return {
      role,
      members: memberships.map((m) => ({ ...m.user, role: m.role, joinedAt: m.createdAt })),
      invitations,
    };
  });

  app.post("/orgs/:orgId/invitations", async (request, reply) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    const { user, role: myRole } = await requireOrgPermission(
      prisma,
      request,
      orgId,
      "members.manage",
    );
    const { email, role } = parse(createInvitationSchema, request.body);
    if (role === "OWNER" && myRole !== "OWNER") {
      throw new HttpError(403, "Only owners can invite another owner");
    }

    const existing = await prisma.membership.findFirst({
      where: { organizationId: orgId, user: { email } },
    });
    if (existing) throw new HttpError(409, `${email} is already on this team`);

    const now = new Date();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    const token = generateToken();
    const invitation = await prisma.$transaction(async (tx) => {
      // Transaction-scoped advisory locks on the sender and the recipient (always in that order)
      // make the quota checks and the insert atomic, and serialize re-invites of one person so two
      // at once can't both stay usable. They take no row locks, so they can't deadlock with
      // acceptance.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invite-sender:${user.id}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invite-to:${email}`}))`;

      const hourAgo = new Date(now.getTime() - HOUR_MS);
      const [bySender, toRecipient] = await Promise.all([
        tx.invitation.count({ where: { invitedById: user.id, createdAt: { gt: hourAgo } } }),
        tx.invitation.count({ where: { email, createdAt: { gt: hourAgo } } }),
      ]);
      if (bySender >= INVITES_PER_SENDER_PER_HOUR) {
        throw new HttpError(429, "You've sent a lot of invitations. Try again in an hour.");
      }
      if (toRecipient >= INVITES_PER_RECIPIENT_PER_HOUR) {
        throw new HttpError(
          429,
          `${email} was invited several times recently. Try again in an hour.`,
        );
      }

      // Re-inviting someone replaces their earlier link, so only the newest one works.
      await tx.invitation.updateMany({
        where: { organizationId: orgId, email, ...openInvitation(now) },
        data: { revokedAt: now },
      });
      return tx.invitation.create({
        data: {
          organizationId: orgId,
          email,
          role,
          tokenHash: hashToken(token),
          invitedById: user.id,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
        },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      });
    });

    const url = `${webBaseUrl}/invite?token=${encodeURIComponent(token)}`;
    await sendOrFail(
      mailer,
      {
        to: email,
        subject: `${user.name} invited you to ${org.name} on TicketApp`,
        text: `${user.name} invited you to join ${org.name} on TicketApp as ${ROLE_NAMES[role]}.\n\nAccept the invitation here. The link works once and expires in ${INVITATION_TTL_DAYS} days.\n\n${url}`,
      },
      request.log,
      () => prisma.invitation.delete({ where: { id: invitation.id } }),
    );
    return reply.code(201).send({ invitation });
  });

  app.delete("/orgs/:orgId/invitations/:invitationId", async (request, reply) => {
    const { orgId, invitationId } = parse(invitationParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "members.manage");
    const { count } = await prisma.invitation.updateMany({
      where: { id: invitationId, organizationId: orgId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new HttpError(404, "Invitation not found");
    return reply.code(204).send();
  });

  /** What the accept page shows before the invitee commits. */
  app.post("/invitations/lookup", async (request) => {
    const { token } = parse(invitationTokenSchema, request.body);
    const invitation = await prisma.invitation.findFirst({
      where: { tokenHash: hashToken(token), ...openInvitation(new Date()) },
      include: {
        organization: { select: { name: true } },
        invitedBy: { select: { name: true } },
      },
    });
    if (!invitation) throw new HttpError(400, "This invitation is invalid, used or expired");
    const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } });
    return {
      email: invitation.email,
      role: invitation.role,
      organization: invitation.organization.name,
      invitedBy: invitation.invitedBy?.name ?? null,
      hasAccount: existingUser !== null,
    };
  });

  /** Accepting proves the invitee owns the email, so it joins them and signs them in. */
  app.post("/invitations/accept", async (request) => {
    const { token, name } = parse(acceptInvitationSchema, request.body);
    const now = new Date();
    const sessionToken = generateToken();

    const result = await prisma.$transaction(async (tx) => {
      const consumed = await tx.invitation.updateManyAndReturn({
        where: { tokenHash: hashToken(token), ...openInvitation(now) },
        data: { acceptedAt: now },
      });
      const invitation = consumed[0];
      if (!invitation) throw new HttpError(400, "This invitation is invalid, used or expired");

      const user = await tx.user.upsert({
        where: { email: invitation.email },
        update: {},
        create: { email: invitation.email, name: name ?? invitation.email.split("@")[0]! },
      });
      // Someone who joined another way keeps their current role.
      await tx.membership.upsert({
        where: {
          userId_organizationId: { userId: user.id, organizationId: invitation.organizationId },
        },
        update: {},
        create: {
          userId: user.id,
          organizationId: invitation.organizationId,
          role: invitation.role,
        },
      });
      await tx.session.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(sessionToken),
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
          userAgent: request.headers["user-agent"]?.slice(0, 500),
        },
      });
      return { user, organizationId: invitation.organizationId };
    });

    return {
      sessionToken,
      user: { id: result.user.id, email: result.user.email, name: result.user.name },
      organizationId: result.organizationId,
    };
  });
}
