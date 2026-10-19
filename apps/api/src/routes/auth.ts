import type { PrismaClient } from "@ticketapp/db";
import { magicLinkRequestSchema, verifyMagicLinkSchema } from "@ticketapp/shared";
import type { FastifyInstance } from "fastify";
import { requireUser, SESSION_TTL_MS } from "../lib/auth";
import { HttpError } from "../lib/errors";
import type { Mailer } from "../lib/mailer";
import { generateToken, hashToken } from "../lib/tokens";
import { parse } from "../lib/validate";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export interface AuthRouteOptions {
  prisma: PrismaClient;
  mailer: Mailer;
  webBaseUrl: string;
}

export async function authRoutes(
  app: FastifyInstance,
  { prisma, mailer, webBaseUrl }: AuthRouteOptions,
) {
  // Always 202 so the response doesn't reveal whether an account exists for the email.
  app.post("/auth/magic-link", async (request, reply) => {
    const { email, name } = parse(magicLinkRequestSchema, request.body);
    const token = generateToken();
    await prisma.magicLinkToken.create({
      data: {
        email,
        name,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
      },
    });

    const link = `${webBaseUrl}/sign-in/verify?token=${encodeURIComponent(token)}`;
    await mailer.send({
      to: email,
      subject: "Your TicketApp sign-in link",
      text: `Use this link to sign in. It works once and expires in 15 minutes.\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
    });

    return reply.code(202).send({ ok: true });
  });

  app.post("/auth/verify", async (request) => {
    const { token } = parse(verifyMagicLinkSchema, request.body);
    const now = new Date();

    // Consume atomically so the same link can't create two sessions.
    const consumed = await prisma.magicLinkToken.updateManyAndReturn({
      where: { tokenHash: hashToken(token), consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    const link = consumed[0];
    if (!link) throw new HttpError(400, "This sign-in link is invalid or has expired");

    const user = await prisma.user.upsert({
      where: { email: link.email },
      update: {},
      create: { email: link.email, name: link.name ?? link.email.split("@")[0] ?? link.email },
    });

    const sessionToken = generateToken();
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(sessionToken),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        userAgent: request.headers["user-agent"]?.slice(0, 500),
      },
    });

    return { sessionToken, user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post("/auth/sign-out", async (request, reply) => {
    await requireUser(prisma, request);
    await prisma.session.update({
      where: { id: request.sessionId },
      data: { revokedAt: new Date() },
    });
    return reply.code(204).send();
  });

  app.get("/me", async (request) => {
    const user = await requireUser(prisma, request);
    const memberships = await prisma.membership.findMany({
      where: { userId: user.id },
      include: { organization: { select: { id: true, name: true, slug: true, type: true } } },
      orderBy: { createdAt: "asc" },
    });
    return {
      user: { id: user.id, email: user.email, name: user.name },
      memberships: memberships.map((m) => ({ role: m.role, organization: m.organization })),
    };
  });
}
