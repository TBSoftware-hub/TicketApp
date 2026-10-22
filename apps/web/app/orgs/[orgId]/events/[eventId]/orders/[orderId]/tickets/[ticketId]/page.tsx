import { formatPhone, roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { loadOrder } from "../../../../../../../../../lib/orders";
import { loadOrg } from "../../../../../../../../../lib/org";
import { EditAttendeeForm, TransferForm } from "../../ticket-forms";

export const metadata: Metadata = { title: "Change a ticket · TicketApp" };

export default async function TicketPage({
  params,
}: {
  params: Promise<{ orgId: string; eventId: string; orderId: string; ticketId: string }>;
}) {
  const { orgId, eventId, orderId, ticketId } = await params;
  const { token, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const { order, studentRoster } = await loadOrder(token, orgId, eventId, orderId);
  const ticket = order.tickets.find((t) => t.id === ticketId);
  if (!ticket) notFound();
  const orderPage = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/orders/${encodeURIComponent(orderId)}`;
  if (ticket.status !== "VALID" || order.status !== "PAID") redirect(orderPage);
  const ref = { orgId, eventId, orderId, ticketId };
  const { attendee: a, ticketType: type } = ticket;
  const holder = `${a.firstName} ${a.lastName}`;

  return (
    <main className="narrow">
      <header className="topbar">
        <a href={orderPage}>← {order.buyerName}&apos;s order</a>
      </header>
      <p className="eyebrow">{type.name}</p>
      <h1>{holder}</h1>

      <section className="card stack">
        <h2>Fix the details</h2>
        <p className="muted">
          For the same person, such as a misspelt name. The QR code stays the same.
        </p>
        <EditAttendeeForm
          ticket={ref}
          firstName={a.firstName}
          lastName={a.lastName}
          emergency={
            type.askEmergencyInfo
              ? {
                  name: a.emergencyContactName ?? "",
                  phone: a.emergencyContactPhone ? formatPhone(a.emergencyContactPhone) : "",
                  notes: a.medicalNotes ?? "",
                }
              : undefined
          }
        />
      </section>

      <section className="card stack">
        <h2>Give it to someone else</h2>
        <p className="muted">
          {holder}&apos;s QR code stops working and the new person gets a new one.
          {ticket._count.signatures > 0 &&
            ` The waivers ${a.firstName} signed stay on record, but they don't cover the new person.`}
        </p>
        <TransferForm
          ticket={ref}
          holder={holder}
          askStudentId={type.studentsOnly && studentRoster}
          askGrade={type.studentsOnly && !studentRoster}
          askEmergency={type.askEmergencyInfo}
        />
      </section>
    </main>
  );
}
