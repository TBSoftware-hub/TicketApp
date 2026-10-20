import { roleCan, utcToZonedLocal } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../../../lib/api";
import type { EventRecord } from "../../../../../../../lib/events";
import { loadOrg } from "../../../../../../../lib/org";
import { centsToDollarsInput, type TicketTypeRecord } from "../../../../../../../lib/ticket-types";
import { deleteTicketType } from "../../../../../../actions";
import { TicketTypeForm } from "../ticket-type-form";

export const metadata: Metadata = { title: "Edit ticket type · TicketApp" };

export default async function EditTicketTypePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string; ticketTypeId: string }>;
  searchParams: Promise<{ deleteFailed?: string }>;
}) {
  const { orgId, eventId, ticketTypeId } = await params;
  const { deleteFailed } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const base = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const [eventRes, typesRes] = await Promise.all([
    api<{ event: EventRecord }>(base, { token }),
    api<{ ticketTypes: TicketTypeRecord[] }>(`${base}/ticket-types`, { token }),
  ]);
  if (eventRes.status === 404 || eventRes.status === 400) notFound();
  if (!("event" in eventRes.data)) throw new Error(`Couldn't load the event (${eventRes.status})`);
  if (!("ticketTypes" in typesRes.data)) {
    throw new Error(`Couldn't load ticket types (${typesRes.status})`);
  }
  const tt = typesRes.data.ticketTypes.find((x) => x.id === ticketTypeId);
  if (!tt) notFound();
  const local = (utc: string | null) => (utc ? utcToZonedLocal(new Date(utc), org.timezone) : "");

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/events/${eventId}`}>← {eventRes.data.event.name}</a>
      </header>
      <p className="eyebrow">{eventRes.data.event.name}</p>
      <h1>{tt.name}</h1>
      {tt.sold > 0 && <p className="muted">{tt.sold} sold so far.</p>}
      <TicketTypeForm
        orgId={orgId}
        eventId={eventId}
        ticketTypeId={tt.id}
        timezone={org.timezone}
        initial={{
          name: tt.name,
          price: centsToDollarsInput(tt.priceCents),
          quantity: tt.quantity === null ? "" : String(tt.quantity),
          maxPerOrder: String(tt.maxPerOrder),
          salesStartAt: local(tt.salesStartAt),
          salesEndAt: local(tt.salesEndAt),
          studentsOnly: tt.studentsOnly,
          minGrade: tt.minGrade === null ? "" : String(tt.minGrade),
          maxGrade: tt.maxGrade === null ? "" : String(tt.maxGrade),
          requiresApproval: tt.requiresApproval,
          salesStartAtUtc: tt.salesStartAt,
          salesEndAtUtc: tt.salesEndAt,
        }}
      />
      {deleteFailed && (
        <p className="notice error" role="alert">
          {tt.hasTickets
            ? "Tickets have been issued for this type, so it can't be deleted."
            : "We couldn't delete this ticket type. Try again."}
        </p>
      )}
      {!tt.hasTickets && (
        <section>
          <form action={deleteTicketType}>
            <input type="hidden" name="orgId" value={orgId} />
            <input type="hidden" name="eventId" value={eventId} />
            <input type="hidden" name="ticketTypeId" value={tt.id} />
            <button type="submit" className="link">
              Delete this ticket type
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
