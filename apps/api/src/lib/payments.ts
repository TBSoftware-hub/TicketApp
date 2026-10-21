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
  /** Kept by the platform to cover Stripe's fee and the service fee. */
  applicationFeeCents: number;
  buyerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
}

export interface RefundResult {
  id: string;
  /** Stripe's refund status: `succeeded` or `pending` mean it's on its way; `failed` or `canceled` mean it isn't. */
  status: string;
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
  /**
   * Gives a paid order's money back in full, taking it back from the school's account, and hands
   * the school back `returnFeeCents` of what the platform kept. Asking again for the same order
   * returns the refund already made rather than making another.
   */
  refund(request: {
    orderId: string;
    paymentIntentId: string;
    returnFeeCents: number;
  }): Promise<RefundResult>;
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
    async refund({ orderId, paymentIntentId, returnFeeCents }) {
      const refund = await refundPayment(orderId, paymentIntentId);
      if (returnFeeCents > 0 && refund.status !== "failed" && refund.status !== "canceled") {
        await returnFee(orderId, paymentIntentId, returnFeeCents);
      }
      return refund;
    },
  };

  async function refundPayment(orderId: string, paymentIntentId: string): Promise<RefundResult> {
    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          // The school got the money, so it gives it back. Stripe doesn't return its own fee on
          // a refund, so the fee we kept to pay it stays with us. The service fee goes back below.
          reverse_transfer: true,
          refund_application_fee: false,
          metadata: { orderId },
        },
        { idempotencyKey: `order-refund-${orderId}` },
      );
      return { id: refund.id, status: refund.status ?? "pending" };
    } catch (err) {
      // Stripe forgets idempotency keys after a day; a retry after that finds the refund instead.
      if (err instanceof Stripe.errors.StripeError && err.code === "charge_already_refunded") {
        const { data } = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 1 });
        if (data[0]) return { id: data[0].id, status: data[0].status ?? "pending" };
      }
      throw err;
    }
  }

  // The service fee is only earned on tickets that are kept, so a refund hands it back to the
  // school. Only what hasn't been returned yet is sent, so asking again sends nothing more.
  async function returnFee(orderId: string, paymentIntentId: string, cents: number) {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge.application_fee"],
    });
    const charge = intent.latest_charge;
    const fee = typeof charge === "object" ? charge?.application_fee : null;
    if (!fee || typeof fee !== "object") return;
    const owed = Math.min(cents, fee.amount) - fee.amount_refunded;
    if (owed <= 0) return;
    await stripe.applicationFees.createRefund(
      fee.id,
      { amount: owed, metadata: { orderId } },
      { idempotencyKey: `order-fee-return-${orderId}` },
    );
  }

  return {
    livemode: secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_"),
    createAccount: (org) => viaStripe(() => payments.createAccount(org)),
    onboardingLink: (id, urls) => viaStripe(() => payments.onboardingLink(id, urls)),
    accountStatus: (id) => viaStripe(() => payments.accountStatus(id)),
    dashboardLink: (id) => viaStripe(() => payments.dashboardLink(id)),
    createCheckout: (r) => viaStripe(() => payments.createCheckout(r)),
    checkoutState: (id) => viaStripe(() => payments.checkoutState(id)),
    expireCheckout: (id) => viaStripe(() => payments.expireCheckout(id)),
    refund: (r) => viaStripe(() => payments.refund(r)),
  };
}

/** Stripe when STRIPE_SECRET_KEY is set; otherwise payments stay switched off. */
export function paymentsFromEnv(): Payments | undefined {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? createStripePayments(key) : undefined;
}
