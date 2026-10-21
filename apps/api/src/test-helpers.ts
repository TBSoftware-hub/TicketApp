import "dotenv/config";
import { createPrismaClient } from "@ticketapp/db";
import type { FastifyServerOptions } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp, type AppDeps } from "./app";
import type { MailMessage } from "./lib/mailer";
import { HttpError } from "./lib/errors";
import type {
  CheckoutRequest,
  CheckoutState,
  PaymentAccountStatus,
  Payments,
} from "./lib/payments";

/** Builds the app against the test database with a mailer that records messages instead of sending. */
export async function buildTestApp(
  overrides: Partial<AppDeps> = {},
  options: FastifyServerOptions = {},
) {
  const prisma = createPrismaClient();
  const sent: MailMessage[] = [];
  /** Set above zero to make that many sends fail, as a provider outage would. */
  const mailFailures = { remaining: 0 };
  const app = await buildApp(
    {
      prisma,
      webBaseUrl: "https://dashboard.test",
      mailer: {
        send: async (m) => {
          if (mailFailures.remaining > 0) {
            mailFailures.remaining--;
            throw new Error("Mail provider is down");
          }
          sent.push(m);
        },
      },
      // Tests sign in many times from one address; the IP limit has its own test.
      magicLinkPerIpPerMinute: 10_000,
      checkoutPerIpPerMinute: 10_000,
      ...overrides,
    },
    options,
  );

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
    mailFailures,
    signIn,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

export const uniqueSlug = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

/** Stands in for Stripe: hands out ids and reports whatever status a test sets. */
export function fakePayments() {
  const created: string[] = [];
  const statuses = new Map<string, PaymentAccountStatus>();
  const checkouts = new Map<string, CheckoutRequest & { state: CheckoutState }>();
  /** Set to hold status reads until the test releases them; `entered` fires when one starts. */
  const gate: { wait?: Promise<void>; entered?: () => void } = {};
  /** Set to make the next payment page fail to open. */
  const failures = { checkout: false, refund: false, feeReturn: false };
  /** The status Stripe gives the next refund it makes. */
  const refundOutcome = { status: "succeeded" };
  /** Refunds made, by order; asking again for the same order returns the same one, as Stripe does. */
  const refunds = new Map<string, { id: string; paymentIntentId: string; status: string }>();
  /** Fees handed back to schools, by order. */
  const returnedFees = new Map<string, number>();
  /** Orders whose fee return always fails. */
  const failingFeeReturns = new Set<string>();
  const payments: Payments = {
    livemode: false,
    async createAccount() {
      const id = `acct_${randomUUID()}`;
      created.push(id);
      return id;
    },
    async onboardingLink(accountId, { refreshUrl, returnUrl }) {
      const params = new URLSearchParams({ refresh: refreshUrl, return: returnUrl });
      return `https://connect.stripe.test/setup/${accountId}?${params}`;
    },
    async accountStatus(accountId) {
      gate.entered?.();
      await gate.wait;
      return (
        statuses.get(accountId) ?? {
          chargesEnabled: false,
          payoutsEnabled: false,
          detailsSubmitted: false,
          requirementsDue: 5,
          pendingVerification: false,
          disabledReason: "requirements.past_due",
        }
      );
    },
    async dashboardLink(accountId) {
      return `https://connect.stripe.test/express/${accountId}`;
    },
    async createCheckout(request) {
      if (failures.checkout) {
        failures.checkout = false;
        throw new Error("Stripe is down");
      }
      const id = `cs_test_${randomUUID()}`;
      checkouts.set(id, { ...request, state: { status: "open", paymentIntentId: null } });
      return { id, url: `https://checkout.stripe.test/${id}` };
    },
    async checkoutState(sessionId) {
      return checkouts.get(sessionId)!.state;
    },
    async expireCheckout(sessionId) {
      const checkout = checkouts.get(sessionId)!;
      if (checkout.state.status === "open")
        checkout.state = { status: "expired", paymentIntentId: null };
      return checkout.state;
    },
    async refund({ orderId, paymentIntentId }) {
      if (failures.refund) {
        failures.refund = false;
        throw new HttpError(502, "Stripe didn't respond. Try again in a minute.");
      }
      const existing = refunds.get(orderId);
      if (existing) return { id: existing.id, status: existing.status };
      const refund = { id: `re_${randomUUID()}`, paymentIntentId, status: refundOutcome.status };
      refunds.set(orderId, refund);
      return { id: refund.id, status: refund.status };
    },
    async returnFee({ orderId, cents }) {
      if (failures.feeReturn || failingFeeReturns.has(orderId)) {
        failures.feeReturn = false;
        throw new HttpError(502, "Stripe didn't respond. Try again in a minute.");
      }
      // As with Stripe, only what hasn't gone back yet is sent.
      returnedFees.set(orderId, Math.max(cents, returnedFees.get(orderId) ?? 0));
    },
  };
  /** As if the buyer finished paying on Stripe's page. */
  const pay = (sessionId: string) => {
    checkouts.get(sessionId)!.state = { status: "paid", paymentIntentId: `pi_${randomUUID()}` };
  };
  /** As if the buyer left Stripe's page open until it closed. */
  const expire = (sessionId: string) => {
    checkouts.get(sessionId)!.state = { status: "expired", paymentIntentId: null };
  };
  return {
    payments,
    created,
    statuses,
    checkouts,
    gate,
    failures,
    refunds,
    returnedFees,
    failingFeeReturns,
    refundOutcome,
    pay,
    expire,
  };
}
