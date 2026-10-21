import Stripe from "stripe";
import { HttpError } from "./errors";

export interface PaymentAccountStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** How many pieces of information Stripe still needs before it can pay out. */
  requirementsDue: number;
  /** Stripe is checking details it already has. */
  pendingVerification: boolean;
  /** Why Stripe has turned off charges, such as `rejected.fraud`; null when nothing is wrong. */
  disabledReason: string | null;
}

export interface CheckoutRequest {
  /** The organization's connected account, which receives the money. */
  accountId: string;
  orderId: string;
  /** Shown on Stripe's payment page; our page has already shown the breakdown. */
  lines: { name: string; amountCents: number }[];
  /** Kept by the platform to cover Stripe's fee. */
  applicationFeeCents: number;
  buyerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
}

export interface CheckoutState {
  status: "open" | "paid" | "expired";
  paymentIntentId: string | null;
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
  /** Starts Stripe's hosted payment page, which also offers Apple Pay and Google Pay. */
  createCheckout(request: CheckoutRequest): Promise<{ id: string; url: string }>;
  checkoutState(sessionId: string): Promise<CheckoutState>;
  /** Closes the payment page if it's still open, then reports where it ended up. */
  expireCheckout(sessionId: string): Promise<CheckoutState>;
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

function stateOf(session: Stripe.Checkout.Session): CheckoutState {
  const paymentIntent = session.payment_intent;
  return {
    status:
      session.payment_status === "paid"
        ? "paid"
        : session.status === "expired"
          ? "expired"
          : "open",
    paymentIntentId:
      typeof paymentIntent === "string" ? paymentIntent : (paymentIntent?.id ?? null),
  };
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
        pendingVerification: (account.requirements?.pending_verification?.length ?? 0) > 0,
        disabledReason: account.requirements?.disabled_reason ?? null,
      };
    },
    async dashboardLink(accountId) {
      const link = await stripe.accounts.createLoginLink(accountId);
      return link.url;
    },
    async createCheckout(r) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          // Cards settle at once (Apple Pay and Google Pay included). Delayed methods such as bank
          // debits would leave seats held with no outcome until webhooks (E4.6) handle them.
          allowed_payment_method_types: ["card"],
          customer_email: r.buyerEmail,
          client_reference_id: r.orderId,
          line_items: r.lines.map((line) => ({
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: line.amountCents,
              product_data: { name: line.name },
            },
          })),
          // A destination charge: the school is the merchant of record and gets the money, less
          // the fee we keep to pay Stripe.
          payment_intent_data: {
            application_fee_amount: r.applicationFeeCents,
            on_behalf_of: r.accountId,
            transfer_data: { destination: r.accountId },
            metadata: { orderId: r.orderId },
          },
          metadata: { orderId: r.orderId },
          success_url: r.successUrl,
          cancel_url: r.cancelUrl,
          expires_at: Math.floor(r.expiresAt.getTime() / 1000),
        },
        { idempotencyKey: `order-checkout-${r.orderId}` },
      );
      if (!session.url) throw new Error(`Checkout session ${session.id} has no URL`);
      return { id: session.id, url: session.url };
    },
    async checkoutState(sessionId) {
      return stateOf(await stripe.checkout.sessions.retrieve(sessionId));
    },
    async expireCheckout(sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.status !== "open") return stateOf(session);
      return stateOf(await stripe.checkout.sessions.expire(sessionId));
    },
  };
  return {
    livemode: secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_"),
    createAccount: (org) => viaStripe(() => payments.createAccount(org)),
    onboardingLink: (id, urls) => viaStripe(() => payments.onboardingLink(id, urls)),
    accountStatus: (id) => viaStripe(() => payments.accountStatus(id)),
    dashboardLink: (id) => viaStripe(() => payments.dashboardLink(id)),
    createCheckout: (r) => viaStripe(() => payments.createCheckout(r)),
    checkoutState: (id) => viaStripe(() => payments.checkoutState(id)),
    expireCheckout: (id) => viaStripe(() => payments.expireCheckout(id)),
  };
}

/** Stripe when STRIPE_SECRET_KEY is set; otherwise payments stay switched off. */
export function paymentsFromEnv(): Payments | undefined {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? createStripePayments(key) : undefined;
}
