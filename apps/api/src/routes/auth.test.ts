import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-helpers";

describe("staff sign-in", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  function linkToken(email: string) {
    const mail = t.sent.findLast((m) => m.to === email)!;
    return new URL(mail.text.match(/https:\S+/)![0]).searchParams.get("token")!;
  }

  it("emails a one-time link and exchanges it for a session", async () => {
    const email = `new-${randomUUID()}@Example.com`;
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email, name: "Jordan Lee" },
    });
    expect(res.statusCode).toBe(202);

    const mail = t.sent.findLast((m) => m.to === email.toLowerCase())!;
    expect(mail.text).toContain("https://dashboard.test/sign-in/verify?token=");

    const verify = await t.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { token: linkToken(email.toLowerCase()) },
    });
    expect(verify.statusCode).toBe(200);
    const body = verify.json();
    expect(body.user).toMatchObject({ email: email.toLowerCase(), name: "Jordan Lee" });

    const me = await t.app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${body.sessionToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: email.toLowerCase() }, memberships: [] });
  });

  it("stores only hashes of sign-in links", async () => {
    const email = `hash-${randomUUID()}@example.com`;
    await t.app.inject({ method: "POST", url: "/auth/magic-link", payload: { email } });
    const row = await t.prisma.magicLinkToken.findFirstOrThrow({ where: { email } });
    expect(row.tokenHash).not.toBe(linkToken(email));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a link the second time it is used", async () => {
    const email = `reuse-${randomUUID()}@example.com`;
    await t.app.inject({ method: "POST", url: "/auth/magic-link", payload: { email } });
    const token = linkToken(email);
    const first = await t.app.inject({ method: "POST", url: "/auth/verify", payload: { token } });
    const second = await t.app.inject({ method: "POST", url: "/auth/verify", payload: { token } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
  });

  it("rejects an expired link", async () => {
    const email = `expired-${randomUUID()}@example.com`;
    await t.app.inject({ method: "POST", url: "/auth/magic-link", payload: { email } });
    await t.prisma.magicLinkToken.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { token: linkToken(email) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires a valid session and stops honouring it after sign-out", async () => {
    expect((await t.app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);

    const { headers } = await t.signIn();
    expect((await t.app.inject({ method: "GET", url: "/me", headers })).statusCode).toBe(200);
    expect(
      (await t.app.inject({ method: "POST", url: "/auth/sign-out", headers })).statusCode,
    ).toBe(204);
    expect((await t.app.inject({ method: "GET", url: "/me", headers })).statusCode).toBe(401);
  });

  it("rejects a malformed email", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("stops sending links to one email after five in fifteen minutes", async () => {
    const email = `limited-${randomUUID()}@example.com`;
    const request = () =>
      t.app.inject({ method: "POST", url: "/auth/magic-link", payload: { email } });
    for (let i = 0; i < 5; i++) expect((await request()).statusCode).toBe(202);

    const res = await request();
    expect(res.statusCode).toBe(429);
    expect(t.sent.filter((m) => m.to === email)).toHaveLength(5);
    expect(await t.prisma.magicLinkToken.count({ where: { email } })).toBe(5);
  });
});

describe("sign-in link requests per IP", () => {
  it("returns 429 once a client passes the per-minute limit", async () => {
    const t = await buildTestApp({ magicLinkPerIpPerMinute: 2 });
    try {
      const request = () =>
        t.app.inject({
          method: "POST",
          url: "/auth/magic-link",
          payload: { email: `ip-${randomUUID()}@example.com` },
        });
      expect((await request()).statusCode).toBe(202);
      expect((await request()).statusCode).toBe(202);
      expect((await request()).statusCode).toBe(429);
      expect(t.sent).toHaveLength(2);
    } finally {
      await t.close();
    }
  });
});
