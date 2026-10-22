import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loadOrder } from "../../../../../../../lib/orders";
import { loadOrg } from "../../../../../../../lib/org";
import { ResendForm } from "./ticket-forms";

export const metadata: Metadata = { title: "Order · TicketApp" };

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string; orderId: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { orgId, eventId, orderId } = await params;
  const { done } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const { order } = await loadOrder(token, orgId, eventId, orderId);
  const base = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const open = order.status === "PAID";
  const valid = order.tickets.filter((t) => t.status === "VALID");
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
        <a href={`${base}/orders`}>← Orders</a>
      </header>
      <p className="eyebrow">Ordered {date.format(new Date(order.createdAt))}</p>
      <h1>{order.buyerName}</h1>
      {done && (
        <p className="notice" role="status">
          {done}
        </p>
      )}
      {!open && (
        <p className="notice">This order is cancelled, so its tickets can&apos;t change.</p>
      )}

      <section className="card stack">
        <h2>Tickets</h2>
        <ul className="stack-tight">
          {order.tickets.map((t) => (
            <li key={t.id}>
              <span className={t.status === "VALID" && open ? undefined : "muted struck"}>
                {t.attendee.firstName} {t.attendee.lastName}
              </span>{" "}
              · {t.ticketType.name}
              {t.status === "VALID" && open ? (
                <>
                  {" · "}
                  <a
                    href={`${base}/orders/${encodeURIComponent(order.id)}/tickets/${encodeURIComponent(t.id)}`}
                  >
                    Change
                  </a>
                </>
              ) : (
                open && <span className="muted"> · given to someone else</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {open && valid.length > 0 && (
        <section className="card stack">
          <h2>Send the tickets again</h2>
          <p className="muted">
            Emails every ticket in this order with its QR code. Fix the address here if it was
            mistyped. The email has a new link to the order, and the old one stops working.
          </p>
          <ResendForm order={{ orgId, eventId, orderId }} email={order.buyerEmail ?? ""} />
        </section>
      )}
    </main>
  );
}
