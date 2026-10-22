import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../../lib/api";
import type { EventRecord } from "../../../../../../lib/events";
import { loadOrg } from "../../../../../../lib/org";
import type { TicketTypeRecord } from "../../../../../../lib/ticket-types";
import { voidComp } from "../../../../../actions";
import { CompForm } from "./comp-form";

export const metadata: Metadata = { title: "Comp tickets · TicketApp" };

interface CompRecord {
  id: string;
  buyerEmail: string;
  note: string | null;
  status: "PENDING" | "PAID" | "REFUNDED" | "CANCELLED";
  createdAt: string;
  compedBy: { name: string } | null;
  tickets: {
    id: string;
    status: "VALID" | "VOID";
    ticketType: { id: string; name: string };
    attendee: { firstName: string; lastName: string };
  }[];
}

export default async function CompsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId, eventId } = await params;
  const { error } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const base = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const [eventRes, typesRes, compsRes] = await Promise.all([
    api<{ event: EventRecord }>(base, { token }),
    api<{ ticketTypes: TicketTypeRecord[] }>(`${base}/ticket-types`, { token }),
    api<{ comps: CompRecord[] }>(`${base}/comps`, { token }),
  ]);
  if (eventRes.status === 404 || eventRes.status === 400) notFound();
  if (!("event" in eventRes.data)) throw new Error(`Couldn't load the event (${eventRes.status})`);
  if (!("ticketTypes" in typesRes.data) || !("comps" in compsRes.data)) {
    throw new Error(`Couldn't load comp tickets (${compsRes.status})`);
  }
  const event = eventRes.data.event;
  const ticketTypes = typesRes.data.ticketTypes;
  const comps = compsRes.data.comps;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: org.timezone,
    month: "short",
    day: "numeric",
  });

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/events/${eventId}`}>← {event.name}</a>
      </header>
      <p className="eyebrow">{event.name}</p>
      <h1>Comp tickets</h1>
      <p className="muted">
        Free tickets for chaperones, sponsors and guests. They skip the eligibility rules but still
        count toward each ticket type&apos;s limit and the event capacity.
      </p>

      <section>
        <h2>Issue a comp ticket</h2>
        {event.status === "CANCELLED" ? (
          <p className="muted">This event is cancelled.</p>
        ) : ticketTypes.length === 0 ? (
          <p className="muted">Add a ticket type first.</p>
        ) : (
          <CompForm
            orgId={orgId}
            eventId={eventId}
            ticketTypes={ticketTypes.map(({ id, name }) => ({ id, name }))}
          />
        )}
      </section>

      {comps.length > 0 && (
        <section>
          <h2>Issued</h2>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <ul className="cards">
            {comps.map((c) => {
              // The holder now, after any transfer; a voided comp shows its last holder.
              const ticket = c.tickets.find((t) => t.status === "VALID") ?? c.tickets.at(-1);
              const voided = c.status === "CANCELLED";
              return (
                <li key={c.id} className="card row">
                  <span className="stack-tight">
                    <strong className={voided ? "muted struck" : undefined}>
                      {ticket
                        ? `${ticket.attendee.firstName} ${ticket.attendee.lastName}`
                        : c.buyerEmail}
                    </strong>
                    <span className="muted">
                      {ticket?.ticketType.name} · {c.buyerEmail}
                    </span>
                    <span className="muted">
                      {voided ? "Voided" : `Issued ${date.format(new Date(c.createdAt))}`}
                      {c.compedBy && ` by ${c.compedBy.name}`}
                      {c.note && ` · ${c.note}`}
                    </span>
                  </span>
                  {!voided && (
                    <form action={voidComp}>
                      <input type="hidden" name="orgId" value={orgId} />
                      <input type="hidden" name="eventId" value={eventId} />
                      <input type="hidden" name="orderId" value={c.id} />
                      <button type="submit" className="link">
                        Void
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
