import type { PrismaClient } from "@ticketapp/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import type { PaymentAccountStatus, Payments } from "../lib/payments";
import { parse } from "../lib/validate";

const orgParamsSchema = z.object({ orgId: z.uuid() });

const NOT_CONNECTED: PaymentAccountStatus = {
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: 0,
  pendingVerification: false,
  disabledReason: null,
};

/** Payout setup is limited to owners, since it decides where the organization's money goes. */
export async function paymentRoutes(
  app: FastifyInstance,
  {
    prisma,
    payments,
    webBaseUrl,
  }: { prisma: PrismaClient; payments?: Payments; webBaseUrl: string },
) {
  const flags = (status: PaymentAccountStatus) => ({
    stripeChargesEnabled: status.chargesEnabled,
    stripePayoutsEnabled: status.payoutsEnabled,
    stripeDetailsSubmitted: status.detailsSubmitted,
  });
  type OrgAccount = { id: string; stripeAccountId: string | null; stripeLivemode: boolean | null };
  // Only writes if the org still has the account the status was read for, so a slow request
  // can't stamp an old account's status onto one that replaced it.
  const saveStatus = (org: OrgAccount, status: PaymentAccountStatus) =>
    prisma.organization.updateMany({
      where: {
        id: org.id,
        stripeAccountId: org.stripeAccountId,
        stripeLivemode: org.stripeLivemode,
      },
      data: flags(status),
    });

  function requirePayments(): Payments {
    if (!payments) throw new HttpError(503, "Payments aren't switched on yet");
    return payments;
  }

  /** The org's account for the current key's mode; one saved in the other mode doesn't count. */
  async function currentAccount(orgId: string, stripe: Payments) {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        stripeAccountId: true,
        stripeLivemode: true,
        stripeDetailsSubmitted: true,
      },
    });
    const usable = org.stripeAccountId && org.stripeLivemode === stripe.livemode;
    return { org, accountId: usable ? org.stripeAccountId : null };
  }

  app.get("/orgs/:orgId/payments", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "org.manage");
    if (!payments) return { payments: { available: false, connected: false } };
    const { org, accountId } = await currentAccount(orgId, payments);
    if (!accountId) {
      // A test-mode account left over after switching to a live key can't take payments.
      if (org.stripeAccountId) await saveStatus(org, NOT_CONNECTED);
      return { payments: { available: true, connected: false } };
    }
    // Read live so the page is right straight after returning from Stripe, and keep the cached
    // flags checkout relies on in step.
    const status = await payments.accountStatus(accountId);
    await saveStatus(org, status);
    return { payments: { available: true, connected: true, ...status } };
  });

  // Starts or resumes Stripe's hosted setup; links are single use, so each visit gets a new one.
  app.post("/orgs/:orgId/payments/onboarding", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "org.manage");
    const stripe = requirePayments();
    const current = await currentAccount(orgId, stripe);
    let accountId = current.accountId;
    if (!accountId) {
      const created = await stripe.createAccount(current.org);
      // Only replace what we read (nothing, or an account from the other mode), so a concurrent
      // request can't swap in a different account.
      await prisma.organization.updateMany({
        where: { id: orgId, stripeAccountId: current.org.stripeAccountId },
        data: {
          stripeAccountId: created,
          stripeLivemode: stripe.livemode,
          ...flags(NOT_CONNECTED),
        },
      });
      const saved = await currentAccount(orgId, stripe);
      if (!saved.accountId) throw new HttpError(409, "Payout setup changed. Try again.");
      accountId = saved.accountId;
    }
    const page = `${webBaseUrl}/orgs/${orgId}/payouts`;
    const url = await stripe.onboardingLink(accountId, {
      refreshUrl: `${page}?expired=1`,
      returnUrl: page,
    });
    return { url };
  });

  app.post("/orgs/:orgId/payments/dashboard", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "org.manage");
    const stripe = requirePayments();
    const { org, accountId } = await currentAccount(orgId, stripe);
    if (!accountId || !org.stripeDetailsSubmitted) {
      throw new HttpError(409, "Finish setting up payouts first");
    }
    return { url: await stripe.dashboardLink(accountId) };
  });
}
