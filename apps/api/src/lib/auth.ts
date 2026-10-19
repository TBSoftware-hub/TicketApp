import type { PrismaClient, User } from "@ticketapp/db";
import { roleCan, type Permission, type Role } from "@ticketapp/shared";
import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors";
import { hashToken } from "./tokens";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

declare module "fastify" {
  interface FastifyRequest {
    sessionId?: string;
    user?: User;
  }
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

/** Resolve the signed-in staff member from the Authorization header, or reject with 401. */
export async function requireUser(prisma: PrismaClient, request: FastifyRequest): Promise<User> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Sign in required");

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw new HttpError(401, "Session expired. Sign in again.");
  }

  request.sessionId = session.id;
  request.user = session.user;
  return session.user;
}

/**
 * Require the signed-in user to hold `permission` in the organization. Non-members get 404 rather
 * than 403 so organization ids can't be probed.
 */
export async function requireOrgPermission(
  prisma: PrismaClient,
  request: FastifyRequest,
  organizationId: string,
  permission: Permission,
): Promise<{ user: User; role: Role }> {
  const user = await requireUser(prisma, request);
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId } },
  });
  if (!membership) throw new HttpError(404, "Organization not found");
  if (!roleCan(membership.role, permission)) {
    throw new HttpError(403, "Your role doesn't allow this");
  }
  return { user, role: membership.role };
}
