import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../../../lib/api";
import type { EventRecord } from "../../../../../../../lib/events";
import { loadOrg } from "../../../../../../../lib/org";
import { loadWaiverSummaries, waiverChoices } from "../../../../../../../lib/waivers";
import { TicketTypeForm } from "../ticket-type-form";

export const metadata: Metadata = { title: "New ticket type · TicketApp" };

export default async function NewTicketTypePage({
  params,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
}) {
  const { orgId, eventId } = await params;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const [{ status, data }, waivers] = await Promise.all([
    api<{ event: EventRecord }>(
      `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`,
      { token },
    ),
    loadWaiverSummaries(orgId, token),
  ]);
  if (status === 404 || status === 400) notFound();
  if (!("event" in data)) throw new Error(`Couldn't load the event (${status})`);

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/events/${eventId}`}>← {data.event.name}</a>
      </header>
      <p className="eyebrow">{data.event.name}</p>
      <h1>New ticket type</h1>
      <TicketTypeForm
        orgId={orgId}
        eventId={eventId}
        ticketTypeId={null}
        timezone={org.timezone}
        initial={{
          name: "",
          price: "",
          quantity: "",
          maxPerOrder: "10",
          salesStartAt: "",
          salesEndAt: "",
          studentsOnly: false,
          minGrade: "",
          maxGrade: "",
          requiresApproval: false,
          askEmergencyInfo: false,
          waiverIds: [],
        }}
        waivers={waiverChoices(waivers)}
      />
    </main>
  );
}
