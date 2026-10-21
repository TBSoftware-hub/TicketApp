import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { api } from "../../../../../lib/api";
import { formatEventTime } from "../../../../../lib/events";
import { canBuyOnline, loadPublicEvent, publicEventPath } from "../../../../../lib/public-events";
import { CheckoutForm } from "./checkout-form";

type Params = Promise<{ orgSlug: string; eventSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { orgSlug, eventSlug } = await params;
  const { event } = await loadPublicEvent(orgSlug, eventSlug);
  return { title: `Tickets · ${event.name}`, robots: { index: false } };
}

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ cancelled?: string; key?: string }>;
}) {
  const { orgSlug, eventSlug } = await params;
  const { cancelled, key } = await searchParams;
  const { event, ticketTypes } = await loadPublicEvent(orgSlug, eventSlug);
  const eventPath = publicEventPath(orgSlug, eventSlug);
  if (cancelled && key) {
    // Stripe sent the buyer back without paying: close its page so their seats go back now.
    const { data } = await api<{ order: { status: string } }>(
      `/public/orders/${encodeURIComponent(cancelled)}/cancel`,
      { method: "POST", body: { key } },
    );
    if ("order" in data && data.order.status === "PAID") {
      redirect(
        `${eventPath}/orders/${encodeURIComponent(cancelled)}?key=${encodeURIComponent(key)}`,
      );
    }
  }
  const buyable = ticketTypes.filter((tt) => canBuyOnline(tt, event));

  return (
    <main className="public">
      <p className="eyebrow">{event.organizationName}</p>
      <h1>{event.name}</h1>
      <p className="muted">{formatEventTime(event.startsAt, event.endsAt, event.timezone)}</p>
      <p>
        <a href={eventPath}>← Back to the event</a>
      </p>
      {cancelled && (
        <p className="notice" role="status">
          You left the payment page, so nothing was charged. You can start again below.
        </p>
      )}
      {buyable.length === 0 ? (
        <p className="notice">There aren&apos;t any tickets you can buy online right now.</p>
      ) : (
        <CheckoutForm
          orgSlug={orgSlug}
          eventSlug={eventSlug}
          ticketTypes={buyable}
          cardFeePaidBy={event.cardFeePaidBy}
        />
      )}
    </main>
  );
}
