import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loadOrg } from "../../../../../lib/org";
import { WaiverForm } from "../waiver-form";

export const metadata: Metadata = { title: "New waiver · TicketApp" };

export default async function NewWaiverPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/waivers`}>← Waivers</a>
      </header>
      <p className="eyebrow">{org.name}</p>
      <h1>New waiver</h1>
      <WaiverForm
        orgId={orgId}
        waiverId={null}
        version={null}
        initial={{ title: "", body: "", requiresGuardianForMinors: true, fields: [] }}
      />
    </main>
  );
}
