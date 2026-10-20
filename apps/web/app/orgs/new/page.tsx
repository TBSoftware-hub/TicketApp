import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionToken } from "../../../lib/session";
import { NewOrganizationForm } from "./new-organization-form";

export const metadata: Metadata = { title: "New organization · TicketApp" };

export default async function NewOrganizationPage() {
  if (!(await getSessionToken())) redirect("/sign-in");
  return (
    <main className="narrow">
      <p className="eyebrow">TicketApp</p>
      <h1>Set up your organization</h1>
      <p className="muted">
        The school, committee or nonprofit running the event. You&apos;ll be its owner and can
        invite your team next.
      </p>
      <NewOrganizationForm />
    </main>
  );
}
