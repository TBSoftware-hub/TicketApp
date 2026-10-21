import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../lib/api";
import { formatEventTime } from "../../../../../lib/events";
import { loadOrg } from "../../../../../lib/org";
import type { WaiverRecord } from "../../../../../lib/waivers";
import { archiveWaiver, deleteWaiver } from "../../../../actions";
import { WaiverForm } from "../waiver-form";

export const metadata: Metadata = { title: "Edit waiver · TicketApp" };

export default async function EditWaiverPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; waiverId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId, waiverId } = await params;
  const { error } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const { status, data } = await api<{ waiver: WaiverRecord }>(
    `/orgs/${encodeURIComponent(orgId)}/waivers/${encodeURIComponent(waiverId)}`,
    { token },
  );
  if (status === 404 || status === 400) notFound();
  if (!("waiver" in data)) throw new Error(`Couldn't load the waiver (${status})`);
  const waiver = data.waiver;
  const inUse = waiver.eventCount > 0 || waiver.signatureCount > 0;

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/waivers`}>← Waivers</a>
      </header>
      <p className="eyebrow">{org.name}</p>
      <h1>{waiver.title}</h1>
      <p className="muted">
        Version {waiver.version}
        {waiver.archivedAt && " · Archived"}
        {waiver.signatureCount > 0 &&
          ` · Signed ${waiver.signatureCount} ${waiver.signatureCount === 1 ? "time" : "times"}`}
      </p>
      {inUse && (
        <p className="notice">
          Saving a change makes a new version. People who already signed keep the version they
          signed; everyone else gets the new one.
        </p>
      )}
      {waiver.events.length > 0 && (
        <section>
          <h2>Events using it</h2>
          <ul className="stack-tight">
            {waiver.events.map((e) => (
              <li key={e.id}>
                <a href={`/orgs/${orgId}/events/${e.id}`}>{e.name}</a>{" "}
                <span className="muted">
                  {formatEventTime(e.startsAt, e.endsAt, org.timezone)} · {e.ticketTypes.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <WaiverForm
        orgId={orgId}
        waiverId={waiver.id}
        version={waiver.version}
        initial={{
          title: waiver.title,
          body: waiver.body,
          requiresGuardianForMinors: waiver.requiresGuardianForMinors,
          fields: waiver.fields,
        }}
      />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <section className="links">
        <form action={archiveWaiver}>
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="waiverId" value={waiver.id} />
          <input type="hidden" name="archived" value={waiver.archivedAt ? "false" : "true"} />
          <button type="submit" className="link">
            {waiver.archivedAt ? "Restore this waiver" : "Archive this waiver"}
          </button>
        </form>
        {!inUse && (
          <form action={deleteWaiver}>
            <input type="hidden" name="orgId" value={orgId} />
            <input type="hidden" name="waiverId" value={waiver.id} />
            <button type="submit" className="link">
              Delete this waiver
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
