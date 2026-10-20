import Stripe from "stripe";
import { HttpError } from "./errors";

export interface PaymentAccountStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** How many pieces of information Stripe still needs before it can pay out. */
  requirementsDue: number;
}

/**
 * Each organization gets its own connected account, so ticket money goes straight to the school
 * or group rather than through the platform.
 */
export interface Payments {
  /** True with a live key. Accounts made in test mode don't exist in live mode, and vice versa. */
  livemode: boolean;
  createAccount(org: { id: string; name: string }): Promise<string>;
  onboardingLink(
    accountId: string,
    urls: { refreshUrl: string; returnUrl: string },
  ): Promise<string>;
  accountStatus(accountId: string): Promise<PaymentAccountStatus>;
  dashboardLink(accountId: string): Promise<string>;
}

/** Stripe failures become a 502 people can act on; the original error rides along for the log. */
async function viaStripe<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      throw new HttpError(502, "Stripe didn't respond. Try again in a minute.", { cause: err });
    }
    throw err;
  }
}

export function createStripePayments(secretKey: string): Payments {
  const stripe = new Stripe(secretKey);
  const payments: Omit<Payments, "livemode"> = {
    async createAccount(org) {
      const account = await stripe.accounts.create(
        {
          type: "express",
          country: "US",
          business_profile: { name: org.name },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          metadata: { organizationId: org.id },
        },
        // Two clicks at once get the same account back rather than two accounts.
        { idempotencyKey: `org-account-${org.id}` },
      );
      return account.id;
    },
    async onboardingLink(accountId, { refreshUrl, returnUrl }) {
      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding",
      });
      return link.url;
    },
    async accountStatus(accountId) {
      const account = await stripe.accounts.retrieve(accountId);
      return {
        chargesEnabled: account.charges_enabled ?? false,
        payoutsEnabled: account.payouts_enabled ?? false,
        detailsSubmitted: account.details_submitted ?? false,
        requirementsDue: account.requirements?.currently_due?.length ?? 0,
      };
    },
    async dashboardLink(accountId) {
      const link = await stripe.accounts.createLoginLink(accountId);
      return link.url;
    },
  };
  return {
    livemode: secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_"),
    createAccount: (org) => viaStripe(() => payments.createAccount(org)),
    onboardingLink: (id, urls) => viaStripe(() => payments.onboardingLink(id, urls)),
    accountStatus: (id) => viaStripe(() => payments.accountStatus(id)),
    dashboardLink: (id) => viaStripe(() => payments.dashboardLink(id)),
  };
}

/** Stripe when STRIPE_SECRET_KEY is set; otherwise payments stay switched off. */
export function paymentsFromEnv(): Payments | undefined {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? createStripePayments(key) : undefined;
}
