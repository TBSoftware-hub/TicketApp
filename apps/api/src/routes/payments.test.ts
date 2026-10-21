import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, fakePayments, uniqueSlug } from "../test-helpers";

describe("payout setup", () => {
  const stripe = fakePayments();
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp({ payments: stripe.payments });
  });

  afterAll(async () => {
    await t.close();
  });

  async function orgWithOwner() {
    const owner = await t.signIn();
    const res = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High PTA", slug: uniqueSlug("pta"), type: "NONPROFIT" },
    });
    const orgId = res.json().organization.id as string;
    const call = (method: "GET" | "POST", path = "") =>
      t.app.inject({ method, url: `/orgs/${orgId}/payments${path}`, headers: owner.headers });
    return { owner, orgId, call };
  }

  it("creates one connected account and sends the owner to Stripe to finish setup", async () => {
    const { orgId, call } = await orgWithOwner();
    expect((await call("GET")).json().payments).toEqual({
      available: true,
      connected: false,
      cardFeePaidBy: "ORGANIZATION",
      serviceFeePaidBy: "BUYER",
    });

    const first = await call("POST", "/onboarding");
    expect(first.statusCode).toBe(200);
    const url = new URL(first.json().url);
    expect(url.searchParams.get("return")).toBe(`https://dashboard.test/orgs/${orgId}/payouts`);
    expect(url.searchParams.get("refresh")).toBe(
      `https://dashboard.test/orgs/${orgId}/payouts?expired=1`,
    );

    // Coming back later resumes the same account rather than starting another.
    const before = stripe.created.length;
    const again = await call("POST", "/onboarding");
    expect(new URL(again.json().url).pathname).toBe(url.pathname);
    expect(stripe.created.length).toBe(before);
  });

  it("reports Stripe's status and caches it on the organization", async () => {
    const { orgId, call } = await orgWithOwner();
    await call("POST", "/onboarding");
    const org = await t.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });

    const pending = (await call("GET")).json().payments;
    expect(pending).toMatchObject({ connected: true, chargesEnabled: false, requirementsDue: 5 });
    expect((await call("POST", "/dashboard")).statusCode).toBe(409);

    stripe.statuses.set(org.stripeAccountId!, {
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsDue: 0,
      pendingVerification: false,
      disabledReason: null,
    });
    const ready = (await call("GET")).json().payments;
    expect(ready).toMatchObject({ connected: true, chargesEnabled: true, payoutsEnabled: true });
    const cached = await t.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(cached).toMatchObject({
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeDetailsSubmitted: true,
    });

    const dashboard = await call("POST", "/dashboard");
    expect(dashboard.json().url).toBe(`https://connect.stripe.test/express/${org.stripeAccountId}`);
  });

  it("starts a fresh account when the saved one is from the other Stripe mode", async () => {
    const { orgId, call } = await orgWithOwner();
    const liveAccount = `acct_live_${randomUUID()}`;
    // As if the account was made with a live key and the API now runs on a test key.
    await t.prisma.organization.update({
      where: { id: orgId },
      data: {
        stripeAccountId: liveAccount,
        stripeLivemode: true,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
        stripeDetailsSubmitted: true,
      },
    });

    expect((await call("GET")).json().payments).toEqual({
      available: true,
      connected: false,
      cardFeePaidBy: "ORGANIZATION",
      serviceFeePaidBy: "BUYER",
    });
    const stale = await t.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(stale.stripeChargesEnabled).toBe(false);
    expect((await call("POST", "/dashboard")).statusCode).toBe(409);

    const start = await call("POST", "/onboarding");
    const fresh = await t.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(fresh.stripeAccountId).not.toBe(liveAccount);
    expect(fresh.stripeLivemode).toBe(false);
    expect(new URL(start.json().url).pathname).toBe(`/setup/${fresh.stripeAccountId}`);
  });

  it("doesn't stamp a slow status read onto an account that replaced it", async () => {
    const { orgId, call } = await orgWithOwner();
    await call("POST", "/onboarding");
    const before = await t.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    stripe.statuses.set(before.stripeAccountId!, {
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsDue: 0,
      pendingVerification: false,
      disabledReason: null,
    });

    let release!: () => void;
    stripe.gate.wait = new Promise((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (stripe.gate.entered = resolve));
    const slow = call("GET");
    // The GET has read the original account and is waiting on Stripe.
    await entered;
    // Meanwhile the org moves to a new, not yet set up account.
    await t.prisma.organization.update({
      where: { id: orgId },
      data: { stripeAccountId: `acct_new_${randomUUID()}` },
    });
    release();
    stripe.gate.wait = undefined;
    stripe.gate.entered = undefined;
    await slow;

    const after = await t.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(after.stripeChargesEnabled).toBe(false);
  });

  it("is limited to owners", async () => {
    const { orgId } = await orgWithOwner();
    const admin = await t.signIn();
    await t.prisma.membership.create({
      data: { organizationId: orgId, userId: admin.userId, role: "ADMIN" },
    });
    const res = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/payments/onboarding`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(403);

    const outsider = await t.signIn();
    const hidden = await t.app.inject({
      method: "GET",
      url: `/orgs/${orgId}/payments`,
      headers: outsider.headers,
    });
    expect(hidden.statusCode).toBe(404);
  });
});

describe("payout setup without Stripe configured", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it("says payments are unavailable instead of failing", async () => {
    const owner = await t.signIn();
    const org = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High PTA", slug: uniqueSlug("pta"), type: "NONPROFIT" },
    });
    const base = `/orgs/${org.json().organization.id}/payments`;
    const status = await t.app.inject({ method: "GET", url: base, headers: owner.headers });
    expect(status.json().payments).toEqual({ available: false, connected: false });
    const start = await t.app.inject({
      method: "POST",
      url: `${base}/onboarding`,
      headers: owner.headers,
    });
    expect(start.statusCode).toBe(503);
  });
});
