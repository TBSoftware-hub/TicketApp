import { formatCents, formatDiscount, roleCan, type DiscountType } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../../lib/api";
import type { EventRecord } from "../../../../../../lib/events";
import { loadOrg } from "../../../../../../lib/org";
import type { TicketTypeRecord } from "../../../../../../lib/ticket-types";
import { updatePromoCode } from "../../../../../actions";
import { PromoCodeForm } from "./promo-code-form";

export const metadata: Metadata = { title: "Promo codes · TicketApp" };

interface PromoCodeRecord {
  id: string;
  code: string;
  discountType: DiscountType;
  discountValue: number;
  maxUses: number | null;
  validFrom: string | null;
  validUntil: string | null;
  active: boolean;
  ticketTypeIds: string[];
  uses: number;
}

export default async function PromoCodesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId, eventId } = await params;
  const { error } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const base = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const [eventRes, typesRes, promoRes] = await Promise.all([
    api<{ event: EventRecord }>(base, { token }),
    api<{ ticketTypes: TicketTypeRecord[] }>(`${base}/ticket-types`, { token }),
    api<{ promoCodes: PromoCodeRecord[] }>(`${base}/promo-codes`, { token }),
  ]);
  if (eventRes.status === 404 || eventRes.status === 400) notFound();
  if (!("event" in eventRes.data)) throw new Error(`Couldn't load the event (${eventRes.status})`);
  if (!("ticketTypes" in typesRes.data) || !("promoCodes" in promoRes.data)) {
    throw new Error(`Couldn't load promo codes (${promoRes.status})`);
  }
  const ticketTypes = typesRes.data.ticketTypes;
  const typeName = new Map(ticketTypes.map((tt) => [tt.id, tt.name]));
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: org.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/events/${eventId}`}>← {eventRes.data.event.name}</a>
      </header>
      <p className="eyebrow">{eventRes.data.event.name}</p>
      <h1>Promo codes</h1>
      <p className="muted">Buyers enter these at checkout for a discount.</p>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {promoRes.data.promoCodes.length > 0 && (
        <ul className="cards">
          {promoRes.data.promoCodes.map((p) => (
            <li key={p.id} className="card">
              <span className="ticket-head">
                <strong className="code">{p.code}</strong>
                <strong>{formatDiscount(p, formatCents)}</strong>
              </span>
              <span className="muted">
                {p.maxUses === null ? `Used ${p.uses} times` : `Used ${p.uses} of ${p.maxUses}`}
                {p.ticketTypeIds.length > 0 &&
                  ` · ${p.ticketTypeIds.map((id) => typeName.get(id)).join(", ")} only`}
              </span>
              {(p.validFrom || p.validUntil) && (
                <span className="muted">
                  {p.validFrom && `From ${date.format(new Date(p.validFrom))}`}
                  {p.validFrom && p.validUntil && " · "}
                  {p.validUntil && `Until ${date.format(new Date(p.validUntil))}`}
                </span>
              )}
              <span className="links">
                <span className={p.active ? "on-sale" : "muted"}>
                  {p.active ? "Active" : "Turned off"}
                </span>
                <form action={updatePromoCode}>
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="eventId" value={eventId} />
                  <input type="hidden" name="promoCodeId" value={p.id} />
                  <button
                    type="submit"
                    name="intent"
                    value={p.active ? "deactivate" : "activate"}
                    className="link"
                  >
                    {p.active ? "Turn off" : "Turn on"}
                  </button>
                  {p.uses === 0 && (
                    <>
                      {" · "}
                      <button type="submit" name="intent" value="delete" className="link">
                        Delete
                      </button>
                    </>
                  )}
                </form>
              </span>
            </li>
          ))}
        </ul>
      )}

      <section>
        <h2>Add a promo code</h2>
        {ticketTypes.length === 0 ? (
          <p className="muted">Add a ticket type first.</p>
        ) : (
          <PromoCodeForm
            orgId={orgId}
            eventId={eventId}
            timezone={org.timezone}
            ticketTypes={ticketTypes.map(({ id, name }) => ({ id, name }))}
          />
        )}
      </section>
    </main>
  );
}
