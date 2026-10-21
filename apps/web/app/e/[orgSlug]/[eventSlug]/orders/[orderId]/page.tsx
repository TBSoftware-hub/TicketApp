import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, errorMessage } from "../../../../../../lib/api";
import { formatEventTime } from "../../../../../../lib/events";
import { publicEventPath } from "../../../../../../lib/public-events";
import { formatPrice } from "../../../../../../lib/ticket-types";

export const metadata: Metadata = { title: "Your order", robots: { index: false } };

interface PublicOrder {
  id: string;
  status: "PENDING" | "PAID" | "REFUNDED" | "CANCELLED";
  buyerName: string;
  buyerEmail: string;
  subtotalCents: number;
  discountCents: number;
  feeCents: number;
  totalCents: number;
  event: {
    name: string;
    startsAt: string;
    endsAt: string;
    venue: string | null;
    organizationName: string;
    timezone: string;
  };
  tickets: { id: string; ticketTypeName: string; firstName: string; lastName: string }[];
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; eventSlug: string; orderId: string }>;
  searchParams: Promise<{ key?: string }>;
}) {
  const { orgSlug, eventSlug, orderId } = await params;
  const { key } = await searchParams;
  if (!key) notFound();
  // Also settles the order with Stripe, so this is what turns a payment into tickets.
  const { status, data } = await api<{ order: PublicOrder }>(
    `/public/orders/${encodeURIComponent(orderId)}`,
    { method: "POST", body: { key } },
  );
  if (status === 404 || status === 400) notFound();
  const eventPath = publicEventPath(orgSlug, eventSlug);
  const here = `${eventPath}/orders/${encodeURIComponent(orderId)}?key=${encodeURIComponent(key)}`;
  if (!("order" in data)) {
    return (
      <main className="public">
        <h1>Your order</h1>
        <p className="notice error" role="alert">
          {errorMessage(data)} <a href={here}>Reload</a>
        </p>
      </main>
    );
  }
  const { order } = data;
  const { event } = order;

  return (
    <main className="public">
      <p className="eyebrow">{event.organizationName}</p>
      <h1>{order.status === "PAID" ? "You're going!" : event.name}</h1>
      {order.status === "PAID" ? (
        <p className="notice" role="status">
          {order.tickets.length === 1 ? "Your ticket is" : "Your tickets are"} confirmed for{" "}
          <strong>{event.name}</strong>. Bookmark this page: its link is how you get back to your
          tickets.
        </p>
      ) : order.status === "PENDING" ? (
        <p className="notice" role="status">
          We&apos;re waiting for Stripe to confirm your payment. <a href={here}>Check again</a>
        </p>
      ) : order.status === "CANCELLED" ? (
        <p className="notice error" role="alert">
          This order wasn&apos;t completed, so nothing was charged.{" "}
          <a href={`${eventPath}/checkout`}>Start again</a>
        </p>
      ) : (
        <p className="notice" role="status">
          This order was refunded.
        </p>
      )}

      <dl className="facts">
        <div>
          <dt>When</dt>
          <dd>{formatEventTime(event.startsAt, event.endsAt, event.timezone)}</dd>
        </div>
        {event.venue && (
          <div>
            <dt>Where</dt>
            <dd>{event.venue}</dd>
          </div>
        )}
        <div>
          <dt>Bought by</dt>
          <dd>
            {order.buyerName} ({order.buyerEmail})
          </dd>
        </div>
      </dl>

      <section>
        <h2>Tickets</h2>
        <ul className="cards">
          {order.tickets.map((t) => (
            <li key={t.id} className="card">
              <span className="ticket-head">
                <strong>
                  {t.firstName} {t.lastName}
                </strong>
                <span>{t.ticketTypeName}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack-tight">
        <span className="ticket-head">
          <span>Tickets</span>
          <span>{formatPrice(order.subtotalCents)}</span>
        </span>
        {order.discountCents > 0 && (
          <span className="ticket-head">
            <span>Promo code</span>
            <span>−{formatPrice(order.discountCents)}</span>
          </span>
        )}
        {order.feeCents > 0 && (
          <span className="ticket-head">
            <span>Card processing fee</span>
            <span>{formatPrice(order.feeCents)}</span>
          </span>
        )}
        <span className="ticket-head">
          <strong>{order.status === "PAID" ? "Paid" : "Total"}</strong>
          <strong>{formatPrice(order.totalCents)}</strong>
        </span>
      </section>
    </main>
  );
}
