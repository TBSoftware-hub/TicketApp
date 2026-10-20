import type { Metadata } from "next";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in · TicketApp" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string }>;
}) {
  const { expired } = await searchParams;
  return (
    <main className="narrow">
      <p className="eyebrow">TicketApp</p>
      <h1>Sign in</h1>
      {expired && (
        <p className="notice error" role="alert">
          That sign-in link has expired or was already used.
        </p>
      )}
      <p className="muted">We&apos;ll email you a link that signs you in. No password needed.</p>
      <SignInForm />
    </main>
  );
}
