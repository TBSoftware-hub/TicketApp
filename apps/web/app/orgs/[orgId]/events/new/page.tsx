import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loadOrg } from "../../../../../lib/org";
import { EventForm } from "../event-form";

export const metadata: Metadata = { title: "New event · TicketApp" };

export default async function NewEventPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/events`}>← Events</a>
      </header>
      <p className="eyebrow">{org.name}</p>
      <h1>New event</h1>
      <p className="muted">It starts as a draft. You&apos;ll add tickets before it goes on sale.</p>
      <EventForm
        orgId={orgId}
        eventId={null}
        timezone={org.timezone}
        initial={{
          name: "",
          slug: "",
          venue: "",
          description: "",
          startsAt: "",
          endsAt: "",
          capacity: "",
        }}
      />
    </main>
  );
}
