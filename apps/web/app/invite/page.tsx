import type { Metadata } from "next";
import { api } from "../../lib/api";
import { ROLE_LABELS } from "../../lib/roles";
import { acceptInvitation } from "../actions";
import type { Role } from "@ticketapp/shared";

export const metadata: Metadata = { title: "Join your team · TicketApp" };

interface Invitation {
  email: string;
  role: Role;
  organization: string;
  invitedBy: string | null;
  hasAccount: boolean;
}

/** Like the sign-in link, accepting takes a click so email scanners can't use the invitation up. */
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; retry?: string; invalid?: string }>;
}) {
  const { token, retry, invalid } = await searchParams;
  const lookup = token
    ? await api<Invitation>("/invitations/lookup", { method: "POST", body: { token } })
    : undefined;
  const invitation = lookup && "organization" in lookup.data ? lookup.data : undefined;

  if (!invitation) {
    const unreachable = lookup?.status === 0 || (lookup && lookup.status >= 500);
    return (
      <main className="narrow">
        <p className="eyebrow">TicketApp</p>
        <h1>Join your team</h1>
        <p className="notice error" role="alert">
          {unreachable
            ? "We couldn't reach TicketApp. Your invitation still works, so reload to try again."
            : invalid || token
              ? "This invitation has been used, cancelled or has expired. Ask whoever invited you to send a new one."
              : "This invitation link is incomplete. Open it again from your email."}
        </p>
      </main>
    );
  }

  return (
    <main className="narrow">
      <p className="eyebrow">TicketApp</p>
      <h1>Join {invitation.organization}</h1>
      <p>
        {invitation.invitedBy ?? "Someone"} invited <strong>{invitation.email}</strong> to join as{" "}
        {ROLE_LABELS[invitation.role].toLowerCase()}.
      </p>
      {retry && (
        <p className="notice error" role="alert">
          We couldn&apos;t reach TicketApp. Your invitation still works, so try again.
        </p>
      )}
      <form action={acceptInvitation} className="stack">
        <input type="hidden" name="token" value={token} />
        {!invitation.hasAccount && (
          <label>
            Your name
            <input name="name" required maxLength={100} autoComplete="name" />
          </label>
        )}
        <button type="submit">Accept and sign in</button>
      </form>
    </main>
  );
}
