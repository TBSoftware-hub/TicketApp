"use client";

import {
  MAX_GRADE,
  MAX_MEDICAL_NOTES,
  MIN_GRADE,
  birthDateSchema,
  isMinorAt,
  orderTotal,
  type FeeSettings,
} from "@ticketapp/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type MouseEvent } from "react";
import { API_URL, errorMessage, UNREACHABLE } from "../../../../../lib/api";
import {
  publicEventPath,
  whoCanBuy,
  type PublicTicketType,
  type PublicWaiver,
} from "../../../../../lib/public-events";
import { formatPrice } from "../../../../../lib/ticket-types";
import { WaiverSigning, type WaiverDraft } from "./waiver-signing";

interface Attendee {
  firstName: string;
  lastName: string;
  grade: string;
  /** Asked for on students-only tickets when the school has a roster to look it up on. */
  studentId: string;
  /** What's been filled in on each of the ticket's waivers, by waiver ID. */
  waivers: Record<string, WaiverDraft>;
  /** Asked for when a waiver needs a guardian to sign for minors. */
  dateOfBirth: string;
  guardianName: string;
  guardianEmail: string;
  guardianPhone: string;
  /** Asked for when the ticket type wants an emergency contact. */
  emergencyName: string;
  emergencyPhone: string;
  medicalNotes: string;
}

type AttendeeField = Exclude<keyof Attendee, "waivers">;

const blank: Attendee = {
  firstName: "",
  lastName: "",
  grade: "",
  studentId: "",
  waivers: {},
  dateOfBirth: "",
  guardianName: "",
  guardianEmail: "",
  guardianPhone: "",
  emergencyName: "",
  emergencyPhone: "",
  medicalNotes: "",
};
const blankWaiver: WaiverDraft = { answers: {}, signature: "", agreed: false };
const GRADES = Array.from({ length: MAX_GRADE - MIN_GRADE + 1 }, (_, i) => MIN_GRADE + i);

/**
 * Posts straight from the browser so the API's per-IP limit counts each buyer, not our server.
 */
export function CheckoutForm({
  orgSlug,
  eventSlug,
  ticketTypes,
  waivers,
  event,
  fees,
}: {
  orgSlug: string;
  eventSlug: string;
  ticketTypes: PublicTicketType[];
  waivers: PublicWaiver[];
  event: { startsAt: string; timezone: string; guardianTexts: boolean; studentRoster: boolean };
  fees: FeeSettings;
}) {
  const waiverById = new Map(waivers.map((w) => [w.id, w]));
  const asksStudentId = (tt: PublicTicketType) => tt.studentsOnly && event.studentRoster;
  /** Whether attendees with this ticket give a date of birth, so a guardian can sign for minors. */
  const asksAge = (tt: PublicTicketType) =>
    tt.waiverIds.some((id) => waiverById.get(id)?.requiresGuardianForMinors);
  /** Whether the attendee is under 18 on the day, judged once their date of birth is complete. */
  const isMinor = (a: Attendee) => {
    const dob = birthDateSchema.safeParse(a.dateOfBirth);
    return dob.success && isMinorAt(dob.data, event.startsAt, event.timezone);
  };
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

  function setField(id: string, index: number, field: AttendeeField, value: string) {
    setAttendees((all) => ({
      ...all,
      [id]: all[id]!.map((a, i) => (i === index ? { ...a, [field]: value } : a)),
    }));
  }

  function setWaiver(id: string, index: number, waiverId: string, draft: WaiverDraft) {
    setAttendees((all) => ({
      ...all,
      [id]: all[id]!.map((a, i) =>
        i === index ? { ...a, waivers: { ...a.waivers, [waiverId]: draft } } : a,
      ),
    }));
  }

  async function onSubmit(submit: FormEvent<HTMLFormElement>) {
    submit.preventDefault();
    const form = new FormData(submit.currentTarget);
    const tickets = ticketTypes.flatMap((tt) =>
      (attendees[tt.id] ?? []).map((a) => ({
        ticketTypeId: tt.id,
        firstName: a.firstName,
        lastName: a.lastName,
        // With a roster the school's records give the grade, so the buyer isn't asked.
        grade: !asksStudentId(tt) && a.grade ? Number(a.grade) : null,
        studentId: asksStudentId(tt) ? a.studentId : null,
        dateOfBirth: asksAge(tt) ? a.dateOfBirth || null : null,
        guardian:
          asksAge(tt) && isMinor(a)
            ? {
                name: a.guardianName,
                email: a.guardianEmail || null,
                phone: event.guardianTexts ? a.guardianPhone || null : null,
              }
            : null,
        emergency: tt.askEmergencyInfo
          ? {
              contactName: a.emergencyName,
              contactPhone: a.emergencyPhone,
              medicalNotes: a.medicalNotes || null,
            }
          : null,
        waivers: tt.waiverIds.map((waiverId) => {
          const draft = a.waivers[waiverId] ?? blankWaiver;
          return {
            waiverId,
            version: waiverById.get(waiverId)?.version,
            answers: draft.answers,
            signature: draft.signature,
            agreed: draft.agreed,
          };
        }),
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

      <section className="stack">
        <h2>Tickets</h2>
        <ul className="cards">
          {ticketTypes.map((tt) => {
            const who = whoCanBuy(tt);
            const list = attendees[tt.id] ?? [];
            const needsGrade =
              tt.studentsOnly &&
              !asksStudentId(tt) &&
              (tt.minGrade !== null || tt.maxGrade !== null);
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
                      {asksStudentId(tt) && (
                        <label>
                          Student ID
                          <input
                            required
                            maxLength={40}
                            autoComplete="off"
                            value={a.studentId}
                            onChange={(e) => setField(tt.id, i, "studentId", e.target.value)}
                          />
                        </label>
                      )}
                      {asksAge(tt) && (
                        <label>
                          Date of birth
                          <input
                            type="date"
                            required
                            value={a.dateOfBirth}
                            onChange={(e) => setField(tt.id, i, "dateOfBirth", e.target.value)}
                          />
                        </label>
                      )}
                    </div>
                    {asksAge(tt) && isMinor(a) && (
                      <GuardianFields
                        attendee={a}
                        texts={event.guardianTexts}
                        onChange={(field, value) => setField(tt.id, i, field, value)}
                      />
                    )}
                    {tt.askEmergencyInfo && (
                      <EmergencyFields
                        attendee={a}
                        onChange={(field, value) => setField(tt.id, i, field, value)}
                      />
                    )}
                    {tt.waiverIds.map((waiverId) => {
                      const waiver = waiverById.get(waiverId);
                      return (
                        waiver && (
                          <WaiverSigning
                            key={waiverId}
                            waiver={waiver}
                            signer={`${a.firstName} ${a.lastName}`.trim()}
                            draft={a.waivers[waiverId] ?? blankWaiver}
                            onChange={(draft) => setWaiver(tt.id, i, waiverId, draft)}
                          />
                        )
                      );
                    })}
                  </fieldset>
                ))}
              </li>
            );
          })}
        </ul>
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

/** Who signs for an attendee under 18. They're sent a link once the order goes through. */
function GuardianFields({
  attendee: a,
  texts,
  onChange,
}: {
  attendee: Attendee;
  texts: boolean;
  onChange: (field: AttendeeField, value: string) => void;
}) {
  const first = a.firstName.trim() || "This attendee";
  // The buyer's own details, for the usual case of a parent buying for their child.
  function useMine(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    const value = (name: string) => {
      const input = form?.elements.namedItem(name);
      return input instanceof HTMLInputElement ? input.value : "";
    };
    onChange("guardianName", value("buyerName"));
    onChange("guardianEmail", value("buyerEmail"));
    if (texts) onChange("guardianPhone", value("buyerPhone"));
  }
  return (
    <div className="waiver stack-tight">
      <strong>Parent or guardian</strong>
      <span className="muted hint">
        {first} is under 18, so a parent or guardian signs the waiver too. We&apos;ll send them a
        link {texts ? "by email or text" : "by email"} once you&apos;ve got the tickets.
      </span>
      <div className="row-fields">
        <label>
          Their name
          <input
            required
            maxLength={80}
            autoComplete="off"
            value={a.guardianName}
            onChange={(e) => onChange("guardianName", e.target.value)}
          />
        </label>
        <label>
          Their email{texts && <span className="muted"> (or mobile)</span>}
          <input
            type="email"
            required={!texts || !a.guardianPhone}
            maxLength={254}
            autoComplete="off"
            value={a.guardianEmail}
            onChange={(e) => onChange("guardianEmail", e.target.value)}
          />
        </label>
        {texts && (
          <label>
            Their mobile <span className="muted">(for a text)</span>
            <input
              type="tel"
              maxLength={30}
              autoComplete="off"
              value={a.guardianPhone}
              onChange={(e) => onChange("guardianPhone", e.target.value)}
            />
          </label>
        )}
      </div>
      <p>
        <button type="button" className="link" onClick={useMine}>
          I&apos;m their parent or guardian
        </button>
      </p>
    </div>
  );
}

/** Who to call if something happens at the event, and anything staff should know. */
function EmergencyFields({
  attendee: a,
  onChange,
}: {
  attendee: Attendee;
  onChange: (field: AttendeeField, value: string) => void;
}) {
  const first = a.firstName.trim() || "this attendee";
  // The buyer is usually the person to call.
  function useMine(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    const value = (name: string) => {
      const input = form?.elements.namedItem(name);
      return input instanceof HTMLInputElement ? input.value : "";
    };
    onChange("emergencyName", value("buyerName"));
    onChange("emergencyPhone", value("buyerPhone"));
  }
  return (
    <div className="waiver stack-tight">
      <strong>In an emergency</strong>
      <span className="muted hint">
        Who staff should call if something happens to {first}. Only the school&apos;s event staff
        see this.
      </span>
      <div className="row-fields">
        <label>
          Contact name
          <input
            required
            maxLength={80}
            autoComplete="off"
            value={a.emergencyName}
            onChange={(e) => onChange("emergencyName", e.target.value)}
          />
        </label>
        <label>
          Contact phone
          <input
            type="tel"
            required
            maxLength={30}
            autoComplete="off"
            value={a.emergencyPhone}
            onChange={(e) => onChange("emergencyPhone", e.target.value)}
          />
        </label>
      </div>
      <p>
        <button type="button" className="link" onClick={useMine}>
          Use my name and phone
        </button>
      </p>
      <label>
        Medical notes <span className="muted">(optional)</span>
        <textarea
          rows={3}
          maxLength={MAX_MEDICAL_NOTES}
          placeholder="Allergies, conditions or medication staff should know about"
          value={a.medicalNotes}
          onChange={(e) => onChange("medicalNotes", e.target.value)}
        />
      </label>
    </div>
  );
}
