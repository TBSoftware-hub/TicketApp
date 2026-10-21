import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { api } from "../../../../lib/api";
import { loadOrg } from "../../../../lib/org";
import type { WaiverSummary } from "../../../../lib/waivers";

export const metadata: Metadata = { title: "Waivers · TicketApp" };

function WaiverCard({ orgId, waiver }: { orgId: string; waiver: WaiverSummary }) {
  const questions = waiver.fieldCount === 1 ? "1 question" : `${waiver.fieldCount} questions`;
  const events =
    waiver.eventCount === 0
      ? "Not on any events"
      : waiver.eventCount === 1
        ? "On 1 event"
        : `On ${waiver.eventCount} events`;
  return (
    <li className="card">
      <strong>
        <a href={`/orgs/${orgId}/waivers/${waiver.id}`}>{waiver.title}</a>
      </strong>
      <span className="muted">
        Version {waiver.version} · {questions} · {events}
      </span>
    </li>
  );
}

export default async function WaiversPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const { status, data } = await api<{ waivers: WaiverSummary[] }>(
    `/orgs/${encodeURIComponent(orgId)}/waivers`,
    { token },
  );
  if (!("waivers" in data)) throw new Error(`Couldn't load waivers (${status})`);
  const active = data.waivers.filter((w) => !w.archivedAt);
  const archived = data.waivers.filter((w) => w.archivedAt);

  return (
    <main className="wide">
      <header className="topbar">
        <a href="/">← All organizations</a>
        <a href={`/orgs/${orgId}/waivers/new`} className="button">
          New waiver
        </a>
      </header>
      <p className="eyebrow">{org.name}</p>
      <h1>Waivers</h1>
      {active.length === 0 ? (
        <p className="muted">No waivers yet. Create one, then add it to the events that need it.</p>
      ) : (
        <ul className="cards">
          {active.map((w) => (
            <WaiverCard key={w.id} orgId={orgId} waiver={w} />
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <section>
          <h2>Archived</h2>
          <ul className="cards">
            {archived.map((w) => (
              <WaiverCard key={w.id} orgId={orgId} waiver={w} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
