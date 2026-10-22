import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { api } from "../../../../lib/api";
import { formatEventTime, STATUS_LABELS, type EventRecord } from "../../../../lib/events";
import { loadOrg } from "../../../../lib/org";

export const metadata: Metadata = { title: "Events · TicketApp" };

export default async function EventsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { token, org, role } = await loadOrg(orgId);
  const { status, data } = await api<{ events: EventRecord[] }>(
    `/orgs/${encodeURIComponent(orgId)}/events`,
    { token },
  );
  if (!("events" in data)) throw new Error(`Couldn't load events (${status})`);
  const canManage = roleCan(role, "events.manage");
  const canSell = roleCan(role, "checkin.scan");

  return (
    <main className="wide">
      <header className="topbar">
        <a href="/">← All organizations</a>
        {canManage && (
          <a href={`/orgs/${orgId}/events/new`} className="button">
            New event
          </a>
        )}
      </header>
      <p className="eyebrow">{org.name}</p>
      <h1>Events</h1>
      {data.events.length === 0 ? (
        <p className="muted">
          No events yet.{canManage && " Create your first one to start selling tickets."}
        </p>
      ) : (
        <ul className="cards">
          {data.events.map((e) => (
            <li key={e.id} className="card">
              <strong>
                {canManage ? <a href={`/orgs/${orgId}/events/${e.id}`}>{e.name}</a> : e.name}
              </strong>
              <span className="muted">
                {formatEventTime(e.startsAt, e.endsAt, org.timezone)}
                {e.venue && ` · ${e.venue}`}
              </span>
              <span className="muted">
                {STATUS_LABELS[e.status]}
                {e.capacity !== null && ` · ${e.capacity} capacity`}
              </span>
              {canSell && (
                <span className="links">
                  <a href={`/orgs/${orgId}/events/${e.id}/attendees`}>Attendees</a>
                  {e.status === "PUBLISHED" && (
                    <a href={`/orgs/${orgId}/events/${e.id}/door`}>Door sales</a>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
