import type { Metadata } from "next";
import { verifySignIn } from "../../actions";

export const metadata: Metadata = { title: "Sign in · TicketApp" };

/**
 * The link only signs in after a click: email scanners that open links would otherwise use up
 * the single-use token before the person does.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="narrow">
      <p className="eyebrow">TicketApp</p>
      <h1>Finish signing in</h1>
      {token ? (
        <form action={verifySignIn} className="stack">
          <input type="hidden" name="token" value={token} />
          <button type="submit">Sign in to TicketApp</button>
        </form>
      ) : (
        <p className="notice error">
          This link is incomplete. <a href="/sign-in">Request a new one.</a>
        </p>
      )}
    </main>
  );
}
