import { roleCan, utcToZonedLocal } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../lib/api";
import type { EventRecord } from "../../../../../lib/events";
import { loadOrg } from "../../../../../lib/org";
import {
  formatPrice,
  formatSaleWindow,
  type TicketTypeRecord,
} from "../../../../../lib/ticket-types";
import { EventForm } from "../event-form";

export const metadata: Metadata = { title: "Edit event · TicketApp" };

export default async function EditEventPage({
  params,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
}) {
  const { orgId, eventId } = await params;
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

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/events`}>← Events</a>
      </header>
      <p className="eyebrow">{org.name}</p>
      <h1>{e.name}</h1>
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
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
