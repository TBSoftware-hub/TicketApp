"use client";

import { MAX_GRADE, MIN_GRADE, orderTotal, type FeeSettings } from "@ticketapp/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { API_URL, errorMessage, UNREACHABLE } from "../../../../../lib/api";
import {
  publicEventPath,
  whoCanBuy,
  type PublicTicketType,
} from "../../../../../lib/public-events";
import { formatPrice } from "../../../../../lib/ticket-types";

interface Attendee {
  firstName: string;
  lastName: string;
  grade: string;
}

const blank: Attendee = { firstName: "", lastName: "", grade: "" };
const GRADES = Array.from({ length: MAX_GRADE - MIN_GRADE + 1 }, (_, i) => MIN_GRADE + i);

/**
 * Posts straight from the browser so the API's per-IP limit counts each buyer, not our server.
 */
export function CheckoutForm({
  orgSlug,
  eventSlug,
  ticketTypes,
  fees,
}: {
  orgSlug: string;
  eventSlug: string;
  ticketTypes: PublicTicketType[];
  fees: FeeSettings;
}) {
  const router = useRouter();
  // One attendee per ticket, grouped by ticket type.
  const [attendees, setAttendees] = useState<Record<string, Attendee[]>>(() =>
    Object.fromEntries(ticketTypes.map((tt) => [tt.id, ticketTypes.length === 1 ? [blank] : []])),
  );
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const count = Object.values(attendees).reduce((n, list) => n + list.length, 0);
  const subtotal = ticketTypes.reduce(
    (sum, tt) => sum + tt.priceCents * (attendees[tt.id]?.length ?? 0),
    0,
  );
  const paidTickets = ticketTypes.reduce(
    (n, tt) => n + (tt.priceCents > 0 ? (attendees[tt.id]?.length ?? 0) : 0),
    0,
  );
  const { feeCents, serviceFeeCents, totalCents } = orderTotal(subtotal, paidTickets, fees);

  function setQuantity(id: string, quantity: number) {
    setAttendees((all) => {
      const list = all[id] ?? [];
      const next =
        quantity > list.length
          ? [...list, ...Array.from({ length: quantity - list.length }, () => blank)]
          : list.slice(0, quantity);
      return { ...all, [id]: next };
    });
  }

  function setField(id: string, index: number, field: keyof Attendee, value: string) {
    setAttendees((all) => ({
      ...all,
      [id]: all[id]!.map((a, i) => (i === index ? { ...a, [field]: value } : a)),
    }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const tickets = ticketTypes.flatMap((tt) =>
      (attendees[tt.id] ?? []).map((a) => ({
        ticketTypeId: tt.id,
        firstName: a.firstName,
        lastName: a.lastName,
        grade: a.grade ? Number(a.grade) : null,
      })),
    );
    setSending(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_URL}/public/events/${encodeURIComponent(orgSlug)}/${encodeURIComponent(eventSlug)}/checkout`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            buyerName: form.get("buyerName"),
            buyerEmail: form.get("buyerEmail"),
            buyerPhone: form.get("buyerPhone") || null,
            promoCode: form.get("promoCode") || null,
            tickets,
          }),
        },
      );
      const data: unknown = await res.json().catch(() => null);
      if (res.status === 201 && data && typeof data === "object" && "orderId" in data) {
        const { orderId, key, paymentUrl } = data as {
          orderId: string;
          key: string;
          paymentUrl: string | null;
        };
        // Paid orders go to Stripe, which sends the buyer back to the order page.
        if (paymentUrl) return window.location.assign(paymentUrl);
        return router.push(
          `${publicEventPath(orgSlug, eventSlug)}/orders/${orderId}?key=${encodeURIComponent(key)}`,
        );
      }
      setError(
        res.status === 429 ? "Too many tries. Wait a minute and try again." : errorMessage(data),
      );
    } catch {
      setError(UNREACHABLE);
    }
    setSending(false);
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <section className="stack">
        <h2>Tickets</h2>
        <ul className="cards">
          {ticketTypes.map((tt) => {
            const who = whoCanBuy(tt);
            const list = attendees[tt.id] ?? [];
            const needsGrade = tt.studentsOnly && (tt.minGrade !== null || tt.maxGrade !== null);
            const grades = GRADES.filter(
              (g) =>
                (tt.minGrade === null || g >= tt.minGrade) &&
                (tt.maxGrade === null || g <= tt.maxGrade),
            );
            return (
              <li key={tt.id} className="card">
                <span className="ticket-head">
                  <strong>{tt.name}</strong>
                  <strong>{formatPrice(tt.priceCents)}</strong>
                </span>
                {who && <span>{who}</span>}
                <label>
                  How many
                  <select
                    value={list.length}
                    onChange={(e) => setQuantity(tt.id, Number(e.target.value))}
                  >
                    {Array.from({ length: tt.maxPerOrder + 1 }, (_, n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                {list.map((a, i) => (
                  <fieldset key={i} className="stack-tight">
                    <legend>
                      {tt.name} ticket{list.length > 1 ? ` ${i + 1}` : ""}: who&apos;s going?
                    </legend>
                    <div className="row-fields">
                      <label>
                        First name
                        <input
                          required
                          maxLength={80}
                          value={a.firstName}
                          onChange={(e) => setField(tt.id, i, "firstName", e.target.value)}
                        />
                      </label>
                      <label>
                        Last name
                        <input
                          required
                          maxLength={80}
                          value={a.lastName}
                          onChange={(e) => setField(tt.id, i, "lastName", e.target.value)}
                        />
                      </label>
                      {needsGrade && (
                        <label>
                          Grade
                          <select
                            required
                            value={a.grade}
                            onChange={(e) => setField(tt.id, i, "grade", e.target.value)}
                          >
                            <option value="">Choose</option>
                            {grades.map((g) => (
                              <option key={g} value={g}>
                                {g}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                  </fieldset>
                ))}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="stack">
        <h2>Your details</h2>
        <p className="muted hint">So the school can reach you about your order.</p>
        <label>
          Your name
          <input name="buyerName" autoComplete="name" required maxLength={80} />
        </label>
        <label>
          Email
          <input name="buyerEmail" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <label>
          Phone <span className="muted">(optional)</span>
          <input name="buyerPhone" type="tel" autoComplete="tel" maxLength={30} />
        </label>
        <label>
          Promo code <span className="muted">(optional)</span>
          <input name="promoCode" autoCapitalize="characters" maxLength={24} />
        </label>
      </section>

      <section className="stack-tight" aria-live="polite">
        <span className="ticket-head">
          <span>
            {count} {count === 1 ? "ticket" : "tickets"}
          </span>
          <span>{formatPrice(subtotal)}</span>
        </span>
        {serviceFeeCents > 0 && (
          <span className="ticket-head">
            <span>Service fee</span>
            <span>{formatPrice(serviceFeeCents)}</span>
          </span>
        )}
        {feeCents > 0 && (
          <span className="ticket-head">
            <span>Card processing fee</span>
            <span>{formatPrice(feeCents)}</span>
          </span>
        )}
        {totalCents !== subtotal && (
          <span className="ticket-head">
            <strong>Total</strong>
            <strong>{formatPrice(totalCents)}</strong>
          </span>
        )}
        <span className="muted hint">
          {count === 0
            ? "Choose how many tickets you want."
            : subtotal > 0
              ? "A promo code's discount shows on the payment page, before you pay."
              : "These tickets are free."}
        </span>
      </section>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={sending || count === 0}>
        {sending ? "One moment…" : subtotal === 0 ? "Get tickets" : "Continue to payment"}
      </button>
    </form>
  );
}
