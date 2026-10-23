import type { MagicLinkToken, Prisma, PrismaClient } from "@ticketapp/db";
import {
  magicLinkRequestSchema,
  signInCodeRequestSchema,
  verifyMagicLinkSchema,
  verifySignInCodeSchema,
} from "@ticketapp/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac, randomInt } from "node:crypto";
import { requireUser, SESSION_TTL_MS } from "../lib/auth";
import { HttpError } from "../lib/errors";
import type { Mailer } from "../lib/mailer";
import { generateToken, hashToken } from "../lib/tokens";
import { sendOrFail } from "../lib/send";
import { parse } from "../lib/validate";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
/** At most this many links per email address per link lifetime, whoever asks for them. */
const MAX_LINKS_PER_EMAIL = 5;
/** A sign-in code stops working after this many wrong guesses, so six digits can't be brute-forced. */
const MAX_CODE_ATTEMPTS = 5;

/** Turn a consumed link or code into a session, creating the staff account on first sign-in. */
async function startSession(
  tx: Prisma.TransactionClient,
  link: MagicLinkToken,
  sessionToken: string,
  request: FastifyRequest,
  now: Date,
) {
  const user = await tx.user.upsert({
    where: { email: link.email },
    update: {},
    create: { email: link.email, name: link.name ?? link.email.split("@")[0] ?? link.email },
  });

  await tx.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      userAgent: request.headers["user-agent"]?.slice(0, 500),
    },
  });
  return user;
}

/**
 * Serializes sign-in work for one address: issuing links and codes, and checking codes. Without it,
 * requests that arrive together could each see room under a limit before any of them is recorded.
 */
async function lockEmail(tx: Prisma.TransactionClient, email: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sign-in:${email}`}))`;
}

/** Call inside lockEmail. Throws 429 once the address has had its links and codes for the window. */
async function checkIssueLimit(tx: Prisma.TransactionClient, email: string) {
  const recent = await tx.magicLinkToken.count({
    where: { email, createdAt: { gt: new Date(Date.now() - MAGIC_LINK_TTL_MS) } },
  });
  if (recent >= MAX_LINKS_PER_EMAIL) {
    throw new HttpError(429, "Too many sign-in requests. Try again in a few minutes.");
  }
}

/** Unexpired, unused codes for the address. Wrong guesses are counted on each of them. */
const openCodes = (email: string, now: Date) => ({
  email,
  codeHash: { not: null },
  consumedAt: null,
  expiresAt: { gt: now },
});

/**
 * Wrong guesses against the address in the current window. Every open code carries the same count,
 * and a new code starts from it, so asking for another code never buys more guesses.
 */
async function wrongGuesses(tx: Prisma.TransactionClient, email: string, now: Date) {
  const { _max } = await tx.magicLinkToken.aggregate({
    where: openCodes(email, now),
    _max: { failedAttempts: true },
  });
  return _max.failedAttempts ?? 0;
}

/**
 * A six-digit code has only a million values, so a plain hash could be reversed by trying them all.
 * Keying the hash with a server-only secret means a leaked table alone doesn't give codes away.
 */
function hashCode(key: string, email: string, code: string) {
  return createHmac("sha256", key).update(`${email}:${code}`).digest("hex");
}

/** An address whose door app code is fixed, for app store review. */
export interface ReviewSignIn {
  email: string;
  code: string;
}

export interface AuthRouteOptions {
  prisma: PrismaClient;
  mailer: Mailer;
  webBaseUrl: string;
  /** Key for sign-in code hashes; without one, code sign-in is switched off. */
  signInCodeKey?: string;
  /** The app store review account, whose code never changes; every other limit still applies. */
  reviewSignIn?: ReviewSignIn;
  /** Sign-in link requests allowed per client IP per minute. */
  magicLinkPerIpPerMinute: number;
}

export async function authRoutes(
  app: FastifyInstance,
  {
    prisma,
    mailer,
    webBaseUrl,
    signInCodeKey,
    reviewSignIn,
    magicLinkPerIpPerMinute,
  }: AuthRouteOptions,
) {
  function codeKey() {
    if (!signInCodeKey) {
      throw new HttpError(503, "Door app sign-in isn't set up yet. Ask your TicketApp admin.");
    }
    return signInCodeKey;
  }

  // Links and codes share one allowance per client. One limiter instance has one counter; a
  // route's own rateLimit config would get a counter of its own even with a shared groupId.
  const signInRequestLimit = {
    preHandler: app.rateLimit({ max: magicLinkPerIpPerMinute, timeWindow: "1 minute" }),
  };
  const verifyCodeLimit = { rateLimit: { max: magicLinkPerIpPerMinute, timeWindow: "1 minute" } };

  // Always 202 so the response doesn't reveal whether an account exists for the email.
  app.post("/auth/magic-link", signInRequestLimit, async (request, reply) => {
    const { email, name } = parse(magicLinkRequestSchema, request.body);
    const token = generateToken();
    const link = await prisma.$transaction(async (tx) => {
      await lockEmail(tx, email);
      await checkIssueLimit(tx, email);
      return tx.magicLinkToken.create({
        data: {
          email,
          name,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
        },
      });
    });

    const url = `${webBaseUrl}/sign-in/verify?token=${encodeURIComponent(token)}`;
    await sendOrFail(
      mailer,
      {
        to: email,
        subject: "Your TicketApp sign-in link",
        text: `Use this link to sign in. It works once and expires in 15 minutes.\n\n${url}\n\nIf you didn't ask for this, you can ignore this email.`,
      },
      request.log,
      () => prisma.magicLinkToken.delete({ where: { id: link.id } }),
    );

    return reply.code(202).send({ ok: true });
  });

  app.post("/auth/verify", async (request) => {
    const { token } = parse(verifyMagicLinkSchema, request.body);
    const now = new Date();

    const sessionToken = generateToken();

    // One transaction: the link is consumed only if the session is created, and the conditional
    // update means the same link can't create two sessions.
    const user = await prisma.$transaction(async (tx) => {
      const consumed = await tx.magicLinkToken.updateManyAndReturn({
        where: { tokenHash: hashToken(token), consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      const link = consumed[0];
      if (!link) throw new HttpError(400, "This sign-in link is invalid or has expired");
      return startSession(tx, link, sessionToken, request, now);
    });

    return { sessionToken, user: { id: user.id, email: user.email, name: user.name } };
  });

  // The door app's sign-in: the same per-email limit as links, but the email carries a code.
  app.post("/auth/sign-in-code", signInRequestLimit, async (request, reply) => {
    const { email } = parse(signInCodeRequestSchema, request.body);
    const key = codeKey();
    const code =
      reviewSignIn?.email === email
        ? reviewSignIn.code
        : randomInt(0, 1_000_000).toString().padStart(6, "0");
    const link = await prisma.$transaction(async (tx) => {
      await lockEmail(tx, email);
      await checkIssueLimit(tx, email);
      const failedAttempts = await wrongGuesses(tx, email, new Date());
      if (failedAttempts >= MAX_CODE_ATTEMPTS) {
        throw new HttpError(429, "Too many wrong codes. Try again in 15 minutes.");
      }
      return tx.magicLinkToken.create({
        data: {
          email,
          // Never sent anywhere: a code row can only be redeemed through /auth/verify-code.
          tokenHash: hashToken(generateToken()),
          codeHash: hashCode(key, email, code),
          failedAttempts,
          expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
        },
      });
    });

    await sendOrFail(
      mailer,
      {
        to: email,
        subject: `${code.slice(0, 3)} ${code.slice(3)} is your TicketApp sign-in code`,
        text: `Enter this code in the TicketApp door app to sign in. It works once and expires in 15 minutes.\n\n${code.slice(0, 3)} ${code.slice(3)}\n\nIf you didn't ask for this, you can ignore this email.`,
      },
      request.log,
      () => prisma.magicLinkToken.delete({ where: { id: link.id } }),
    );

    return reply.code(202).send({ ok: true });
  });

  app.post("/auth/verify-code", { config: verifyCodeLimit }, async (request) => {
    const { email, code } = parse(verifySignInCodeSchema, request.body);
    const key = codeKey();
    const now = new Date();

    const sessionToken = generateToken();
    // Checking the code and counting a wrong guess happen under the address's lock, so guesses
    // that arrive together are each counted before the next one is checked.
    const user = await prisma.$transaction(async (tx) => {
      await lockEmail(tx, email);
      if ((await wrongGuesses(tx, email, now)) >= MAX_CODE_ATTEMPTS) return undefined;
      const consumed = await tx.magicLinkToken.updateManyAndReturn({
        where: { ...openCodes(email, now), codeHash: hashCode(key, email, code) },
        data: { consumedAt: now },
      });
      const link = consumed[0];
      if (link) return startSession(tx, link, sessionToken, request, now);
      await tx.magicLinkToken.updateMany({
        where: openCodes(email, now),
        data: { failedAttempts: { increment: 1 } },
      });
      return undefined;
    });
    if (!user) {
      throw new HttpError(
        400,
        "That code is wrong or has expired. Check the email or ask for a new code.",
      );
    }

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
