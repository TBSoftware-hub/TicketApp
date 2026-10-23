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

describe("client IP behind a proxy", () => {
  it("ignores forged X-Forwarded-For entries when counting requests per IP", async () => {
    const t = await buildTestApp(
      { magicLinkPerIpPerMinute: 2 },
      { trustProxy: (_address: string, hop: number) => hop < 1 },
    );
    try {
      // The proxy appends the address it saw; anything to the left came from the client.
      const request = (forged: string) =>
        t.app.inject({
          method: "POST",
          url: "/auth/magic-link",
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": `${forged}, 203.0.113.7` },
          payload: { email: `proxy-${randomUUID()}@example.com` },
        });
      expect((await request("198.51.100.1")).statusCode).toBe(202);
      expect((await request("198.51.100.2")).statusCode).toBe(202);
      expect((await request("198.51.100.3")).statusCode).toBe(429);
    } finally {
      await t.close();
    }
  });
});

describe("door app sign-in with an emailed code", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  async function requestCode(email: string) {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/sign-in-code",
      payload: { email },
    });
    expect(res.statusCode).toBe(202);
    const mail = t.sent.findLast((m) => m.to === email.toLowerCase())!;
    return mail.text
      .match(/\b(\d{3}) (\d{3})\b/)!
      .slice(1)
      .join("");
  }

  const verify = (email: string, code: string) =>
    t.app.inject({ method: "POST", url: "/auth/verify-code", payload: { email, code } });

  it("emails a six-digit code and exchanges it for a session", async () => {
    const email = `door-${randomUUID()}@Example.com`;
    const code = await requestCode(email);
    const mail = t.sent.findLast((m) => m.to === email.toLowerCase())!;
    expect(mail.subject).toContain(`${code.slice(0, 3)} ${code.slice(3)}`);
    expect(mail.text).not.toContain("https://");

    const res = await verify(email, `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(res.statusCode).toBe(200);
    const me = await t.app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${res.json().sessionToken}` },
    });
    expect(me.json().user.email).toBe(email.toLowerCase());
  });

  it("stores only a hash of the code", async () => {
    const email = `door-hash-${randomUUID()}@example.com`;
    const code = await requestCode(email);
    const row = await t.prisma.magicLinkToken.findFirstOrThrow({ where: { email } });
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(code);
  });

  it("works once", async () => {
    const email = `door-once-${randomUUID()}@example.com`;
    const code = await requestCode(email);
    expect((await verify(email, code)).statusCode).toBe(200);
    expect((await verify(email, code)).statusCode).toBe(400);
  });

  it("only works for the address it was sent to", async () => {
    const email = `door-own-${randomUUID()}@example.com`;
    const code = await requestCode(email);
    expect((await verify(`someone-else-${randomUUID()}@example.com`, code)).statusCode).toBe(400);
    expect((await verify(email, code)).statusCode).toBe(200);
  });

  it("rejects an expired code", async () => {
    const email = `door-expired-${randomUUID()}@example.com`;
    const code = await requestCode(email);
    await t.prisma.magicLinkToken.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await verify(email, code)).statusCode).toBe(400);
  });

  it("stops accepting the right code after five wrong guesses", async () => {
    const email = `door-guess-${randomUUID()}@example.com`;
    const code = await requestCode(email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await verify(email, wrong)).statusCode).toBe(400);
    expect((await verify(email, code)).statusCode).toBe(400);
  });

  it("counts a wrong guess against every open code, so asking again doesn't add guesses", async () => {
    const email = `door-many-${randomUUID()}@example.com`;
    const first = await requestCode(email);
    const second = await requestCode(email);
    const wrong = ["000000", "111111"].find((c) => c !== first && c !== second)!;
    for (let i = 0; i < 5; i++) await verify(email, wrong);
    expect((await verify(email, first)).statusCode).toBe(400);
    expect((await verify(email, second)).statusCode).toBe(400);
  });

  it("carries wrong guesses over to a new code, so asking again doesn't reset them", async () => {
    const email = `door-resend-${randomUUID()}@example.com`;
    const first = await requestCode(email);
    const wrong = first === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await verify(email, wrong);
    const second = await requestCode(email);
    expect(second).not.toBe(wrong);
    expect((await verify(email, wrong)).statusCode).toBe(400);
    expect((await verify(email, second)).statusCode).toBe(400);
  });

  it("won't send another code once five wrong guesses have used up the address's tries", async () => {
    const email = `door-locked-${randomUUID()}@example.com`;
    const code = await requestCode(email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await verify(email, wrong);
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/sign-in-code",
      payload: { email },
    });
    expect(res.statusCode).toBe(429);
  });

  it("counts every guess in a burst and still locks the code after five", async () => {
    const email = `door-race-${randomUUID()}@example.com`;
    const code = await requestCode(email);
    const wrong = code === "000000" ? "111111" : "000000";
    const results = await Promise.all(Array.from({ length: 8 }, () => verify(email, wrong)));
    expect(results.every((r) => r.statusCode === 400)).toBe(true);
    const row = await t.prisma.magicLinkToken.findFirstOrThrow({ where: { email } });
    expect(row.failedAttempts).toBe(5);
    expect((await verify(email, code)).statusCode).toBe(400);
  });

  it("holds the per-email limit when requests arrive at once, across links and codes", async () => {
    const email = `door-burst-${randomUUID()}@example.com`;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        t.app.inject({
          method: "POST",
          url: i % 2 ? "/auth/sign-in-code" : "/auth/magic-link",
          payload: { email },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(5);
    expect(await t.prisma.magicLinkToken.count({ where: { email } })).toBe(5);
  });

  it("shares the five-per-fifteen-minutes limit with sign-in links", async () => {
    const email = `door-limit-${randomUUID()}@example.com`;
    for (let i = 0; i < 3; i++) {
      await t.app.inject({ method: "POST", url: "/auth/magic-link", payload: { email } });
    }
    await requestCode(email);
    await requestCode(email);
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/sign-in-code",
      payload: { email },
    });
    expect(res.statusCode).toBe(429);
  });

  it("can't be redeemed as a sign-in link", async () => {
    const email = `door-link-${randomUUID()}@example.com`;
    const code = await requestCode(email);
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { token: code.padEnd(20, "0") },
    });
    expect(res.statusCode).toBe(400);
  });
});
