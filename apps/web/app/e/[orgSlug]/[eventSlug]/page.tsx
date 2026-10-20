import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { api } from "../../../../lib/api";
import { formatEventTime } from "../../../../lib/events";
import {
  saleStatusLabel,
  whoCanBuy,
  type PublicEvent,
  type PublicTicketType,
} from "../../../../lib/public-events";
import { formatPrice } from "../../../../lib/ticket-types";
import { ShareButton } from "./share-button";

type Params = Promise<{ orgSlug: string; eventSlug: string }>;

// generateMetadata and the page share one request.
const loadEvent = cache(async (orgSlug: string, eventSlug: string) => {
  const { status, data } = await api<{ event: PublicEvent; ticketTypes: PublicTicketType[] }>(
    `/public/events/${encodeURIComponent(orgSlug)}/${encodeURIComponent(eventSlug)}`,
  );
  if (status === 404 || status === 400) notFound();
  if (!("event" in data)) throw new Error(`Couldn't load the event (${status})`);
  return data;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { orgSlug, eventSlug } = await params;
  const { event } = await loadEvent(orgSlug, eventSlug);
  const when = formatEventTime(event.startsAt, event.endsAt, event.timezone);
  const description = [when, event.venue].filter(Boolean).join(" · ");
  const title = `${event.name} · ${event.organizationName}`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function PublicEventPage({ params }: { params: Params }) {
  const { orgSlug, eventSlug } = await params;
  const { event, ticketTypes } = await loadEvent(orgSlug, eventSlug);
  const cancelled = event.status === "CANCELLED";
  const zoneName = event.timezone.split("/").pop()?.replace(/_/g, " ");

  return (
    <main className="public">
      <p className="eyebrow">{event.organizationName}</p>
      <h1>{event.name}</h1>
      {cancelled && (
        <p className="notice error" role="status">
          This event has been cancelled.
        </p>
      )}
      <dl className="facts">
        <div>
          <dt>When</dt>
          <dd>
            {formatEventTime(event.startsAt, event.endsAt, event.timezone)}
            <span className="muted"> ({zoneName} time)</span>
          </dd>
        </div>
        {event.venue && (
          <div>
            <dt>Where</dt>
            <dd>{event.venue}</dd>
          </div>
        )}
      </dl>
      <ShareButton title={event.name} />
      {event.description && <p className="description">{event.description}</p>}

      <section>
        <h2>Tickets</h2>
        {ticketTypes.length === 0 ? (
          <p className="muted">Tickets aren&apos;t available yet.</p>
        ) : (
          <ul className="cards">
            {ticketTypes.map((tt) => {
              const who = whoCanBuy(tt);
              return (
                <li key={tt.id} className="card">
                  <span className="ticket-head">
                    <strong>{tt.name}</strong>
                    <strong>{formatPrice(tt.priceCents)}</strong>
                  </span>
                  {who && <span>{who}</span>}
                  <span className={tt.saleStatus === "onSale" ? "on-sale" : "muted"}>
                    {saleStatusLabel(tt, event.timezone)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {!cancelled && ticketTypes.some((tt) => tt.saleStatus === "onSale") && (
          <p className="muted hint">Online checkout is opening soon.</p>
        )}
      </section>
    </main>
  );
}
