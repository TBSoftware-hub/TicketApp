import type { Metadata } from "next";
import { api, errorMessage } from "../../lib/api";
import { formatEventTime } from "../../lib/events";
import type { GuardianRequest } from "../../lib/guardian-signatures";
import { GuardianSignForm } from "./sign-form";

export const metadata: Metadata = { title: "Sign a waiver", robots: { index: false } };

/** Where a minor's parent or guardian signs, from the link they were emailed or texted. */
export default async function SignPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const { status, data } = token
    ? await api<{ request: GuardianRequest }>("/public/guardian-signatures/view", {
        method: "POST",
        body: { token },
      })
    : { status: 404, data: { error: "" } };
  if (!token || !("request" in data)) {
    return (
      <main className="public">
        <h1>Sign a waiver</h1>
        <p className="notice error" role="alert">
          {status === 404 || status === 400
            ? "This link doesn't work. Ask whoever bought the ticket to check their order."
            : errorMessage(data)}
        </p>
      </main>
    );
  }
  const { request } = data;
  const { event, attendee } = request;
  return (
    <main className="public">
      <p className="eyebrow">{event.organizationName}</p>
      <h1>
        Sign for {attendee.firstName} to go to {event.name}
      </h1>
      <dl className="facts">
        <div>
          <dt>When</dt>
          <dd>{formatEventTime(event.startsAt, event.endsAt, event.timezone)}</dd>
        </div>
        {event.venue && (
          <div>
            <dt>Where</dt>
            <dd>{event.venue}</dd>
          </div>
        )}
        <div>
          <dt>Attendee</dt>
          <dd>
            {attendee.firstName} {attendee.lastName}
          </dd>
        </div>
        <div>
          <dt>Ticket bought by</dt>
          <dd>{request.buyerName}</dd>
        </div>
      </dl>
      <GuardianSignForm token={token} initial={request} />
    </main>
  );
}
