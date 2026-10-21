import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { api, errorMessage } from "../../../../lib/api";
import { loadOrg } from "../../../../lib/org";
import { openStripe } from "../../../actions";

export const metadata: Metadata = { title: "Payouts · TicketApp" };

type PaymentsStatus =
  | { available: boolean; connected: false }
  | {
      available: true;
      connected: true;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      detailsSubmitted: boolean;
      requirementsDue: number;
      pendingVerification: boolean;
      disabledReason: string | null;
    };

export default async function PayoutsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string; expired?: string }>;
}) {
  const { orgId } = await params;
  const { error, expired } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "org.manage")) redirect(`/orgs/${orgId}/events`);
  const { status, data } = await api<{ payments: PaymentsStatus }>(
    `/orgs/${encodeURIComponent(orgId)}/payments`,
    { token },
  );
  if (status === 401) redirect("/sign-in");
  // Stripe can be briefly unreachable; say so and offer a retry rather than an error page.
  const p = "payments" in data ? data.payments : null;

  const stripeButton = (target: "onboarding" | "dashboard", label: string) => (
    <form action={openStripe}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="target" value={target} />
      <button type="submit">{label}</button>
    </form>
  );

  return (
    <main className="narrow">
      <header className="topbar">
        <a href="/">← All organizations</a>
      </header>
      <p className="eyebrow">{org.name}</p>
      <h1>Payouts</h1>
      <p className="muted">
        Ticket money goes straight to {org.name}&apos;s own Stripe account and on to your bank.
        TicketApp never holds it.
      </p>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {expired && (
        <p className="notice" role="status">
          That setup link expired. Pick up where you left off below.
        </p>
      )}

      <section className="stack">
        {!p ? (
          <p className="notice error" role="alert">
            {errorMessage(data)} <a href={`/orgs/${orgId}/payouts`}>Reload</a>
          </p>
        ) : !p.available ? (
          <p className="notice">Payments aren&apos;t switched on yet. Check back soon.</p>
        ) : !p.connected ? (
          <>
            <p>
              Stripe will ask for your organization&apos;s details, a contact person and the bank
              account to pay into. It takes about ten minutes.
            </p>
            {stripeButton("onboarding", "Set up payouts with Stripe")}
          </>
        ) : (
          <>
            {p.chargesEnabled ? (
              <p className="notice" role="status">
                <strong>Ready to sell tickets.</strong>{" "}
                {p.payoutsEnabled
                  ? "Payouts go to your bank account automatically."
                  : p.pendingVerification
                    ? "Stripe is checking your details before the first payout."
                    : "Payouts are on hold until Stripe has what it needs."}
              </p>
            ) : p.disabledReason?.startsWith("rejected") ? (
              <p className="notice error" role="alert">
                Stripe couldn&apos;t approve this account, so it can&apos;t take payments. Open the
                Stripe dashboard or contact Stripe support to find out more.
              </p>
            ) : !p.detailsSubmitted ? (
              <p className="notice" role="status">
                Setup isn&apos;t finished yet.
              </p>
            ) : p.pendingVerification ? (
              <p className="notice" role="status">
                Stripe is reviewing your details. This page updates once you can sell tickets.
              </p>
            ) : p.requirementsDue === 0 ? (
              <p className="notice error" role="alert">
                Stripe has paused payments on this account. Open the Stripe dashboard to see why.
              </p>
            ) : null}
            {/* Whatever the state above, say when Stripe is waiting on the owner. */}
            {p.requirementsDue > 0 && !p.disabledReason?.startsWith("rejected") && (
              <p>
                Stripe needs {p.requirementsDue} more{" "}
                {p.requirementsDue === 1 ? "detail" : "details"} from you.
              </p>
            )}
            {(p.requirementsDue > 0 || !p.detailsSubmitted) &&
              stripeButton("onboarding", p.detailsSubmitted ? "Update details" : "Continue setup")}
            {p.detailsSubmitted && stripeButton("dashboard", "Open Stripe dashboard")}
          </>
        )}
      </section>
    </main>
  );
}
