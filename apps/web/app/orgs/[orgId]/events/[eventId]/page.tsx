import { roleCan, utcToZonedLocal } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../lib/api";
import type { EventRecord } from "../../../../../lib/events";
import { loadOrg } from "../../../../../lib/org";
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
  const { status, data } = await api<{ event: EventRecord }>(
    `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`,
    { token },
  );
  if (status === 404 || status === 400) notFound();
  if (!("event" in data)) throw new Error(`Couldn't load the event (${status})`);
  const e = data.event;

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
        }}
      />
    </main>
  );
}
