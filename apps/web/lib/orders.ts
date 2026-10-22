import { notFound } from "next/navigation";
import { api } from "./api";

/** One order as staff manage it, with what changing its tickets needs. */
export interface ManagedOrder {
  id: string;
  status: "PAID" | "REFUNDED" | "CANCELLED" | "PENDING";
  paymentMethod: "CARD" | "CASH" | "COMP";
  buyerName: string;
  buyerEmail: string | null;
  createdAt: string;
  tickets: {
    id: string;
    status: "HELD" | "VALID" | "VOID";
    /** Set when staff gave the ticket to someone else. */
    transferredTo: { id: string } | null;
    ticketType: { name: string; studentsOnly: boolean; askEmergencyInfo: boolean };
    attendee: {
      firstName: string;
      lastName: string;
      studentId: string | null;
      emergencyContactName: string | null;
      emergencyContactPhone: string | null;
      medicalNotes: string | null;
    };
    _count: { signatures: number };
  }[];
}

/** Loads an order for a dashboard page, or shows the not-found page. */
export async function loadOrder(token: string, orgId: string, eventId: string, orderId: string) {
  const { status, data } = await api<{ order: ManagedOrder; studentRoster: boolean }>(
    `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/orders/${encodeURIComponent(orderId)}`,
    { token },
  );
  if (status === 404 || status === 400) notFound();
  if (!("order" in data)) throw new Error(`Couldn't load the order (${status})`);
  return data;
}
