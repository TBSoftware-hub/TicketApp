import { formatCents, roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../../lib/api";
import type { EventRecord } from "../../../../../../lib/events";
import { loadOrg } from "../../../../../../lib/org";
import { formatPrice, type TicketTypeRecord } from "../../../../../../lib/ticket-types";
import { DoorSaleForm } from "./door-sale-form";

export const metadata: Metadata = { title: "Door sales · TicketApp" };

interface SaleRecord {
  id: string;
  status: "PAID" | "REFUNDED" | "CANCELLED";
  buyerName: string;
  buyerEmail: string | null;
  totalCents: number;
  createdAt: string;
  soldBy: { name: string } | null;
  tickets: { ticketType: { name: string } }[];
}

export default async function DoorSalesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { orgId, eventId } = await params;
  const { before } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "checkin.scan")) redirect(`/orgs/${orgId}/events`);
  const canManage = roleCan(role, "events.manage");
  const base = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const [eventRes, typesRes, salesRes] = await Promise.all([
    api<{ event: EventRecord }>(base, { token }),
    api<{ ticketTypes: TicketTypeRecord[] }>(`${base}/ticket-types`, { token }),
    api<{ sales: SaleRecord[]; more: boolean; cashCents: number; saleCount: number }>(
      `${base}/door-sales${before ? `?${new URLSearchParams({ before })}` : ""}`,
      { token },
    ),
  ]);
  if (eventRes.status === 404 || eventRes.status === 400) notFound();
  if (!("event" in eventRes.data)) throw new Error(`Couldn't load the event (${eventRes.status})`);
  if (!("ticketTypes" in typesRes.data) || !("sales" in salesRes.data)) {
    throw new Error(`Couldn't load door sales (${salesRes.status})`);
  }
  const event = eventRes.data.event;
  const ticketTypes = typesRes.data.ticketTypes;
  const { sales, more, cashCents, saleCount } = salesRes.data;
  const page = `/orgs/${orgId}/events/${eventId}/door`;
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: org.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={canManage ? `/orgs/${orgId}/events/${eventId}` : `/orgs/${orgId}/events`}>
          ← {canManage ? event.name : "Events"}
        </a>
      </header>
      <p className="eyebrow">{event.name}</p>
      <h1>Door sales</h1>
      <p className="muted">
        Record each ticket sold for cash at the door. Online sale dates and eligibility rules
        don&apos;t apply here, but ticket limits and the event capacity do.
      </p>

      <section>
        <h2>Sell tickets</h2>
        {event.status !== "PUBLISHED" ? (
          <p className="muted">
            {event.status === "CANCELLED"
              ? "This event is cancelled."
              : "Publish the event before selling tickets."}
          </p>
        ) : ticketTypes.length === 0 ? (
          <p className="muted">Add a ticket type first.</p>
        ) : (
          <DoorSaleForm
            orgId={orgId}
            eventId={eventId}
            ticketTypes={ticketTypes.map(({ id, name, priceCents }) => ({ id, name, priceCents }))}
          />
        )}
      </section>

      <section>
        <h2>Cash collected</h2>
        <p>
          <strong>{formatCents(cashCents)}</strong>{" "}
          <span className="muted">from {saleCount === 1 ? "1 sale" : `${saleCount} sales`}</span>
        </p>
        {sales.length > 0 && (
          <ul className="cards">
            {sales.map((s) => {
              const cancelled = s.status !== "PAID";
              const types = [...new Set(s.tickets.map((tk) => tk.ticketType.name))].join(", ");
              const count = s.tickets.length === 1 ? "1 ticket" : `${s.tickets.length} tickets`;
              return (
                <li key={s.id} className="card">
                  <strong className={cancelled ? "muted struck" : undefined}>{s.buyerName}</strong>
                  <span className="muted">
                    {count} · {types} · {formatPrice(s.totalCents)}
                    {cancelled && " · Cancelled"}
                  </span>
                  <span className="muted">
                    {time.format(new Date(s.createdAt))}
                    {s.soldBy && ` by ${s.soldBy.name}`}
                    {s.buyerEmail && ` · ${s.buyerEmail}`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {(more || before) && (
          <p className="links">
            {before && <a href={page}>Latest sales</a>}
            {more && (
              <a href={`${page}?${new URLSearchParams({ before: sales.at(-1)!.id })}`}>
                Older sales
              </a>
            )}
          </p>
        )}
        {canManage && sales.length > 0 && (
          <p className="muted">
            To cancel a sale, find it in{" "}
            <a href={`/orgs/${orgId}/events/${eventId}/orders`}>Orders</a> and hand the cash back.
          </p>
        )}
      </section>
    </main>
  );
}
