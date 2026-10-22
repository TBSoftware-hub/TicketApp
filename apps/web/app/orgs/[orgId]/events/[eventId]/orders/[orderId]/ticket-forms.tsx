"use client";

import { MAX_GRADE, MAX_MEDICAL_NOTES, MIN_GRADE } from "@ticketapp/shared";
import { useActionState } from "react";
import {
  editAttendee,
  resendOrder,
  transferTicket,
  type FormState,
  type TicketRef,
} from "../../../../../../actions";

interface Emergency {
  name: string;
  phone: string;
  notes: string;
}

function EmergencyFields({ initial }: { initial?: Emergency }) {
  return (
    <div className="waiver stack-tight">
      <strong>In an emergency</strong>
      <div className="row-fields">
        <label>
          Contact name
          <input
            name="emergencyName"
            required
            maxLength={80}
            autoComplete="off"
            defaultValue={initial?.name}
          />
        </label>
        <label>
          Contact phone
          <input
            name="emergencyPhone"
            type="tel"
            required
            maxLength={30}
            autoComplete="off"
            defaultValue={initial?.phone}
          />
        </label>
      </div>
      <label>
        Medical notes <span className="muted">(optional)</span>
        <textarea
          name="medicalNotes"
          rows={3}
          maxLength={MAX_MEDICAL_NOTES}
          defaultValue={initial?.notes}
        />
      </label>
    </div>
  );
}

function NameFields({ first, last }: { first?: string; last?: string }) {
  return (
    <div className="row-fields">
      <label>
        First name
        <input name="firstName" required maxLength={80} autoComplete="off" defaultValue={first} />
      </label>
      <label>
        Last name
        <input name="lastName" required maxLength={80} autoComplete="off" defaultValue={last} />
      </label>
    </div>
  );
}

function Problem({ state }: { state: FormState }) {
  return state.error ? (
    <p className="notice error" role="alert">
      {state.error}
    </p>
  ) : null;
}

/** Corrects the name and emergency info on a ticket, for the same person. */
export function EditAttendeeForm({
  ticket,
  firstName,
  lastName,
  emergency,
}: {
  ticket: TicketRef;
  firstName: string;
  lastName: string;
  /** Present when the ticket type asks for emergency info. */
  emergency?: Emergency;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    editAttendee.bind(null, ticket),
    {},
  );
  return (
    <form action={action} className="stack">
      <NameFields first={firstName} last={lastName} />
      {emergency && <EmergencyFields initial={emergency} />}
      <Problem state={state} />
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

/** Gives a ticket to someone else. */
export function TransferForm({
  ticket,
  askStudentId,
  askGrade,
  askEmergency,
  holder,
}: {
  ticket: TicketRef;
  askStudentId: boolean;
  askGrade: boolean;
  askEmergency: boolean;
  holder: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    transferTicket.bind(null, ticket),
    {},
  );
  const grades = Array.from({ length: MAX_GRADE - MIN_GRADE + 1 }, (_, i) => MIN_GRADE + i);
  return (
    <form
      action={action}
      className="stack"
      onSubmit={(e) => {
        if (
          !window.confirm(
            `Give ${holder}'s ticket to someone else? ${holder}'s QR code will stop working.`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <NameFields />
      {askStudentId && (
        <label>
          Student ID
          <input name="studentId" required maxLength={40} autoComplete="off" />
          <span className="muted hint">Checked against the school&apos;s roster.</span>
        </label>
      )}
      {askGrade && (
        <label>
          Grade
          <select name="grade" required defaultValue="">
            <option value="" disabled>
              Pick a grade
            </option>
            {grades.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Email the ticket to <span className="muted">(optional)</span>
        <input name="email" type="email" maxLength={254} autoComplete="off" />
      </label>
      {askEmergency && <EmergencyFields />}
      <Problem state={state} />
      <button type="submit" disabled={pending}>
        {pending ? "Transferring…" : "Transfer the ticket"}
      </button>
    </form>
  );
}

/** Sends an order's tickets again, optionally to a corrected address. */
export function ResendForm({ order, email }: { order: TicketRef; email: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    resendOrder.bind(null, order),
    {},
  );
  return (
    <form action={action} className="stack">
      <label>
        Email
        <input name="email" type="email" required maxLength={254} defaultValue={email} />
      </label>
      <Problem state={state} />
      <button type="submit" className="secondary" disabled={pending}>
        {pending ? "Sending…" : "Send the tickets"}
      </button>
    </form>
  );
}
