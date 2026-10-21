import { roleCan, type Role } from "@ticketapp/shared";
import { redirect } from "next/navigation";
import { api } from "../lib/api";
import { ROLE_LABELS } from "../lib/roles";
import { getSessionToken } from "../lib/session";
import { signOut } from "./actions";

interface Me {
  user: { id: string; email: string; name: string };
  memberships: {
    role: string;
    organization: { id: string; name: string; slug: string; type: string };
  }[];
}

export default async function HomePage() {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const { status, data } = await api<Me>("/me", { token });
  if (status === 401) redirect("/sign-in");
  if (status !== 200 || !("user" in data))
    throw new Error(`Couldn't load your account (${status})`);
  if (data.memberships.length === 0) redirect("/orgs/new");

  return (
    <main className="wide">
      <header className="topbar">
        <p className="eyebrow">TicketApp</p>
        <form action={signOut}>
          <span className="muted">{data.user.email}</span>{" "}
          <button type="submit" className="link">
            Sign out
          </button>
        </form>
      </header>
      <h1>Hi, {data.user.name}</h1>
      <h2>Your organizations</h2>
      <ul className="cards">
        {data.memberships.map(({ organization, role }) => (
          <li key={organization.id} className="card">
            <strong>{organization.name}</strong>
            <span className="muted">
              {ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role} · tickets/{organization.slug}
            </span>
            <span className="links">
              <a href={`/orgs/${organization.id}/events`}>Events</a>
              <a href={`/orgs/${organization.id}/team`}>Team</a>
              {roleCan(role as Role, "events.manage") && (
                <a href={`/orgs/${organization.id}/waivers`}>Waivers</a>
              )}
              {roleCan(role as Role, "org.manage") && (
                <a href={`/orgs/${organization.id}/payouts`}>Payouts</a>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p>
        <a href="/orgs/new">+ New organization</a>
      </p>
    </main>
  );
}
