import "dotenv/config";
import { createPrismaClient } from "@ticketapp/db";
import { randomUUID } from "node:crypto";
import { buildApp } from "./app";
import type { MailMessage } from "./lib/mailer";

/** Builds the app against the test database with a mailer that records messages instead of sending. */
export async function buildTestApp() {
  const prisma = createPrismaClient();
  const sent: MailMessage[] = [];
  const app = await buildApp({
    prisma,
    webBaseUrl: "https://dashboard.test",
    mailer: { send: async (m) => void sent.push(m) },
  });

  async function signIn(email = `staff-${randomUUID()}@example.com`, name = "Test Staff") {
    await app.inject({ method: "POST", url: "/auth/magic-link", payload: { email, name } });
    const mail = sent.findLast((m) => m.to === email);
    const token = new URL(mail!.text.match(/https:\S+/)![0]).searchParams.get("token")!;
    const res = await app.inject({ method: "POST", url: "/auth/verify", payload: { token } });
    const { sessionToken, user } = res.json<{ sessionToken: string; user: { id: string } }>();
    return {
      token: sessionToken,
      userId: user.id,
      headers: { authorization: `Bearer ${sessionToken}` },
    };
  }

  return {
    app,
    prisma,
    sent,
    signIn,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

export const uniqueSlug = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
