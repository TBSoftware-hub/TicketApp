import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../../lib/api";
import type { EventRecord } from "../../../../../../lib/events";
import { loadOrg } from "../../../../../../lib/org";
import { formatPrice } from "../../../../../../lib/ticket-types";
import { cancelOrder } from "../../../../../actions";
import { CancelOrderButton } from "./cancel-button";

export const metadata: Metadata = { title: "Orders · TicketApp" };

interface OrderRecord {
  id: string;
  status: "PAID" | "REFUNDED" | "CANCELLED";
  paymentMethod: "CARD" | "CASH" | "COMP";
  buyerName: string;
  buyerEmail: string | null;
  totalCents: number;
  refundedCents: number;
  createdAt: string;
  cancelledAt: string | null;
  cancelledBy: { name: string } | null;
  promoCode: { code: string } | null;
  tickets: {
    id: string;
    status: "HELD" | "VALID" | "VOID";
    ticketType: { name: string };
    attendee: { firstName: string; lastName: string };
    _count: { signatures: number };
  }[];
}

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<{ q?: string; error?: string }>;
}) {
  const { orgId, eventId } = await params;
  const { q = "", error } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const base = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const search = q ? `?${new URLSearchParams({ q })}` : "";
  const [eventRes, ordersRes] = await Promise.all([
    api<{ event: EventRecord }>(base, { token }),
    api<{ orders: OrderRecord[]; more: boolean }>(`${base}/orders${search}`, { token }),
  ]);
  if (eventRes.status === 404 || eventRes.status === 400) notFound();
  if (!("event" in eventRes.data)) throw new Error(`Couldn't load the event (${eventRes.status})`);
  if (!("orders" in ordersRes.data)) throw new Error(`Couldn't load orders (${ordersRes.status})`);
  const event = eventRes.data.event;
  const { orders, more } = ordersRes.data;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: org.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const summary = (o: OrderRecord) => {
    if (o.status === "REFUNDED") return `Refunded ${formatPrice(o.refundedCents)}`;
    if (o.status === "CANCELLED") return "Cancelled";
    if (o.paymentMethod === "COMP") return "Comp";
    if (o.paymentMethod === "CASH") return `Cash ${formatPrice(o.totalCents)}`;
    return o.totalCents > 0 ? `Paid ${formatPrice(o.totalCents)}` : "Free";
  };

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={`/orgs/${orgId}/events/${eventId}`}>← {event.name}</a>
      </header>
      <p className="eyebrow">{event.name}</p>
      <h1>Orders</h1>
      <p className="muted">
        Cancelling an order voids its tickets and frees their seats. A card payment is refunded in
        full from your Stripe balance; Stripe keeps its processing fee, and the service fee comes
        back to you.
      </p>

      <form className="search-bar" role="search">
        <input
          type="search"
          name="q"
          defaultValue={q}
          aria-label="Search orders"
          placeholder="Buyer, attendee or email"
          maxLength={100}
        />
        <button type="submit" className="secondary">
          Search
        </button>
      </form>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {orders.length === 0 ? (
        <p className="muted">{q ? "No orders match that search." : "No orders yet."}</p>
      ) : (
        <ul className="cards">
          {orders.map((o) => {
            const open = o.status === "PAID";
            const refunds = o.paymentMethod === "CARD" && o.totalCents > 0;
            const count = o.tickets.length === 1 ? "1 ticket" : `${o.tickets.length} tickets`;
            return (
              <li key={o.id} className="card row">
                <span className="stack-tight">
                  <strong className={open ? undefined : "muted struck"}>{o.buyerName}</strong>
                  {o.buyerEmail && <span className="muted">{o.buyerEmail}</span>}
                  {o.tickets.map((t) => (
                    <span key={t.id}>
                      {t.attendee.firstName} {t.attendee.lastName} · {t.ticketType.name}
                      {t._count.signatures > 0 && (
                        <>
                          {" · "}
                          <a href={`${base}/orders/waivers/${encodeURIComponent(t.id)}`}>Waivers</a>
                        </>
                      )}
                    </span>
                  ))}
                  <span className="muted">
                    {summary(o)}
                    {o.promoCode && ` · ${o.promoCode.code}`}
                    {" · "}
                    {o.cancelledAt
                      ? `${date.format(new Date(o.cancelledAt))}${o.cancelledBy ? ` by ${o.cancelledBy.name}` : ""}`
                      : date.format(new Date(o.createdAt))}
                  </span>
                </span>
                {open && (
                  <CancelOrderButton
                    action={cancelOrder}
                    fields={{ orgId, eventId, orderId: o.id, q }}
                    label={refunds ? "Refund" : "Cancel"}
                    question={
                      refunds
                        ? `Refund ${formatPrice(o.totalCents)} to ${o.buyerName} and void their ${count}? This can't be undone.`
                        : o.paymentMethod === "CASH" && o.totalCents > 0
                          ? `Cancel ${o.buyerName}'s order and void their ${count}? Hand back ${formatPrice(o.totalCents)} in cash. This can't be undone.`
                          : `Cancel ${o.buyerName}'s order and void their ${count}? This can't be undone.`
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {more && <p className="muted">Showing the 100 most recent. Search to find an older order.</p>}
    </main>
  );
}
