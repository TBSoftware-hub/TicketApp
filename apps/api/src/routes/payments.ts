import type { PrismaClient } from "@ticketapp/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgPermission } from "../lib/auth";
import { HttpError } from "../lib/errors";
import type { Payments } from "../lib/payments";
import { parse } from "../lib/validate";

const orgParamsSchema = z.object({ orgId: z.uuid() });

/** Payout setup is limited to owners, since it decides where the organization's money goes. */
export async function paymentRoutes(
  app: FastifyInstance,
  {
    prisma,
    payments,
    webBaseUrl,
  }: { prisma: PrismaClient; payments?: Payments; webBaseUrl: string },
) {
  function requirePayments(): Payments {
    if (!payments) throw new HttpError(503, "Payments aren't switched on yet");
    return payments;
  }

  app.get("/orgs/:orgId/payments", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "org.manage");
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { stripeAccountId: true },
    });
    if (!payments || !org.stripeAccountId) {
      return { payments: { available: Boolean(payments), connected: false } };
    }
    // Read live so the page is right straight after returning from Stripe, and keep the cached
    // flags checkout relies on in step.
    const status = await payments.accountStatus(org.stripeAccountId);
    await prisma.organization.update({
      where: { id: orgId },
      data: {
        stripeChargesEnabled: status.chargesEnabled,
        stripePayoutsEnabled: status.payoutsEnabled,
        stripeDetailsSubmitted: status.detailsSubmitted,
      },
    });
    return { payments: { available: true, connected: true, ...status } };
  });

  // Starts or resumes Stripe's hosted setup; links are single use, so each visit gets a new one.
  app.post("/orgs/:orgId/payments/onboarding", async (request) => {
    const { orgId } = parse(orgParamsSchema, request.params);
    await requireOrgPermission(prisma, request, orgId, "org.manage");
    const stripe = requirePayments();
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { id: true, name: true, stripeAccountId: true },
    });
    let accountId = org.stripeAccountId;
    if (!accountId) {
      const created = await stripe.createAccount(org);
      // Only fill an empty slot, so a concurrent request can't swap in a different account.
      await prisma.organization.updateMany({
        where: { id: orgId, stripeAccountId: null },
        data: { stripeAccountId: created },
      });
      const saved = await prisma.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { stripeAccountId: true },
      });
      accountId = saved.stripeAccountId!;
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
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { stripeAccountId: true, stripeDetailsSubmitted: true },
    });
    if (!org.stripeAccountId || !org.stripeDetailsSubmitted) {
      throw new HttpError(409, "Finish setting up payouts first");
    }
    return { url: await stripe.dashboardLink(org.stripeAccountId) };
  });
}
