import { roleCan, utcToZonedLocal } from "@ticketapp/shared";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../lib/api";
import { STATUS_LABELS, type EventRecord } from "../../../../../lib/events";
import { loadOrg } from "../../../../../lib/org";
import { publicEventPath } from "../../../../../lib/public-events";
import {
  formatEligibility,
  formatPrice,
  formatSaleWindow,
  type TicketTypeRecord,
} from "../../../../../lib/ticket-types";
import { setEventStatus } from "../../../../actions";
import { EventForm } from "../event-form";

export const metadata: Metadata = { title: "Edit event · TicketApp" };

export default async function EditEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<{ statusError?: string }>;
}) {
  const { orgId, eventId } = await params;
  const { statusError } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const base = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const [{ status, data }, typesRes] = await Promise.all([
    api<{ event: EventRecord }>(base, { token }),
    api<{ ticketTypes: TicketTypeRecord[] }>(`${base}/ticket-types`, { token }),
  ]);
  if (status === 404 || status === 400) notFound();
  if (!("event" in data)) throw new Error(`Couldn't load the event (${status})`);
  if (!("ticketTypes" in typesRes.data)) {
    throw new Error(`Couldn't load ticket types (${typesRes.status})`);
  }
  const e = data.event;
  const ticketTypes = typesRes.data.ticketTypes;
  const h = await headers();
  const publicUrl = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}${publicEventPath(org.slug, e.slug)}`;
  const statusButton = (status: EventRecord["status"], label: string, className?: string) => (
    <form action={setEventStatus}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="status" value={status} />
      <button type="submit" className={className}>
        {label}
      </button>
    </form>
  );

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/events`}>← Events</a>
      </header>
      <p className="eyebrow">{org.name}</p>
      <h1>{e.name}</h1>
      <section className="card status-panel">
        <span className="stack-tight">
          <strong>{STATUS_LABELS[e.status]}</strong>
          {e.status === "DRAFT" && (
            <span className="muted">Only your team can see it. Publish to share the link.</span>
          )}
          {e.status === "PUBLISHED" && (
            <span className="muted">
              Anyone with the link can see it: <a href={publicUrl}>{publicUrl}</a>
            </span>
          )}
          {e.status === "CANCELLED" && (
            <span className="muted">
              The <a href={publicUrl}>public page</a> says it&apos;s cancelled.
            </span>
          )}
        </span>
        {statusError && (
          <p className="notice error" role="alert">
            {statusError}
          </p>
        )}
        <span className="links">
          {e.status !== "PUBLISHED" && statusButton("PUBLISHED", "Publish")}
          {e.status !== "DRAFT" && statusButton("DRAFT", "Unpublish", "secondary")}
          {e.status === "PUBLISHED" && statusButton("CANCELLED", "Cancel event", "link")}
        </span>
      </section>
      <EventForm
        orgId={orgId}
        eventId={e.id}
        timezone={org.timezone}
        initial={{
          name: e.name,
          slug: e.slug,
          venue: e.venue ?? "",
          description: e.description ?? "",
          startsAt: utcToZonedLocal(new Date(e.startsAt), org.timezone),
          endsAt: utcToZonedLocal(new Date(e.endsAt), org.timezone),
          capacity: e.capacity === null ? "" : String(e.capacity),
          startsAtUtc: e.startsAt,
          endsAtUtc: e.endsAt,
        }}
      />

      <section>
        <header className="section-head">
          <h2>Tickets</h2>
          <a href={`/orgs/${orgId}/events/${eventId}/tickets/new`} className="button">
            Add ticket type
          </a>
        </header>
        {ticketTypes.length === 0 ? (
          <p className="muted">
            No tickets yet. Add at least one type, such as General admission, before the event goes
            on sale.
          </p>
        ) : (
          <ul className="cards">
            {ticketTypes.map((tt) => (
              <li key={tt.id} className="card">
                <strong>
                  <a href={`/orgs/${orgId}/events/${eventId}/tickets/${tt.id}`}>{tt.name}</a>
                  {" · "}
                  {formatPrice(tt.priceCents)}
                </strong>
                <span className="muted">
                  {tt.quantity === null ? `${tt.sold} sold` : `${tt.sold} of ${tt.quantity} sold`}
                  {` · up to ${tt.maxPerOrder} per order`}
                </span>
                <span className="muted">
                  {formatSaleWindow(tt.salesStartAt, tt.salesEndAt, org.timezone)}
                </span>
                <span className="muted">{formatEligibility(tt)}</span>
              </li>
            ))}
          </ul>
        )}
        {ticketTypes.length > 0 && (
          <p className="links">
            <a href={`/orgs/${orgId}/events/${eventId}/orders`}>Orders</a>
            <a href={`/orgs/${orgId}/events/${eventId}/promo-codes`}>Promo codes</a>
            <a href={`/orgs/${orgId}/events/${eventId}/comps`}>Comp tickets</a>
            <a href={`/orgs/${orgId}/events/${eventId}/door`}>Door sales</a>
          </p>
        )}
      </section>
    </main>
  );
}
