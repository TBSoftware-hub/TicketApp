import { roleCan, type Role } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../lib/api";
import { ROLE_LABELS } from "../../../../lib/roles";
import { getSessionToken } from "../../../../lib/session";
import { revokeInvitation } from "../../../actions";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "Team · TicketApp" };

interface Team {
  role: Role;
  members: { id: string; name: string; email: string; role: Role; joinedAt: string }[];
  invitations: { id: string; email: string; role: Role; expiresAt: string }[];
}

interface Me {
  memberships: { organization: { id: string; name: string } }[];
}

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ cancelFailed?: string }>;
}) {
  const { orgId } = await params;
  const { cancelFailed } = await searchParams;
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");

  const [team, me] = await Promise.all([
    api<Team>(`/orgs/${encodeURIComponent(orgId)}/members`, { token }),
    api<Me>("/me", { token }),
  ]);
  if (team.status === 401 || me.status === 401) redirect("/sign-in");
  if (team.status === 404 || team.status === 400) notFound();
  if (!("members" in team.data) || !("memberships" in me.data)) {
    throw new Error(`Couldn't load the team (${team.status})`);
  }
  const { role, members, invitations } = team.data;
  const orgName =
    me.data.memberships.find((m) => m.organization.id === orgId)?.organization.name ?? "Team";
  const canManage = roleCan(role, "members.manage");

  return (
    <main className="wide">
      <header className="topbar">
        <a href="/">← All organizations</a>
      </header>
      <p className="eyebrow">{orgName}</p>
      <h1>Team</h1>

      {canManage && (
        <section>
          <h2>Invite someone</h2>
          <InviteForm orgId={orgId} canInviteOwners={role === "OWNER"} />
        </section>
      )}

      <section>
        <h2>Members</h2>
        <ul className="cards">
          {members.map((m) => (
            <li key={m.id} className="card">
              <strong>{m.name}</strong>
              <span className="muted">
                {m.email} · {ROLE_LABELS[m.role]}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {canManage && invitations.length > 0 && (
        <section>
          <h2>Waiting to accept</h2>
          {cancelFailed && (
            <p className="notice error" role="alert">
              We couldn&apos;t cancel that invitation, so its link may still work. Try again.
            </p>
          )}
          <ul className="cards">
            {invitations.map((inv) => (
              <li key={inv.id} className="card row">
                <span className="stack-tight">
                  <strong>{inv.email}</strong>
                  <span className="muted">
                    {ROLE_LABELS[inv.role]} · link expires{" "}
                    {dateFormat.format(new Date(inv.expiresAt))}
                  </span>
                </span>
                <form action={revokeInvitation}>
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="invitationId" value={inv.id} />
                  <button type="submit" className="link">
                    Cancel invite
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
