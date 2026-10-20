"use client";

import { useActionState } from "react";
import { useClearingForm } from "../../../../../../lib/use-clearing-form";
import { issueComp, type CreatedState } from "../../../../../actions";

export function CompForm({
  orgId,
  eventId,
  ticketTypes,
}: {
  orgId: string;
  eventId: string;
  ticketTypes: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState<CreatedState, FormData>(
    issueComp.bind(null, orgId, eventId),
    {},
  );
  const { formRef, doneRef, onSubmit } = useClearingForm(state.done, formAction);

  return (
    <form ref={formRef} onSubmit={onSubmit} className="stack">
      <label>
        Ticket type
        <select name="ticketTypeId" required defaultValue={ticketTypes[0]?.id}>
          {ticketTypes.map((tt) => (
            <option key={tt.id} value={tt.id}>
              {tt.name}
            </option>
          ))}
        </select>
      </label>
      <div className="row-fields">
        <label>
          First name
          <input name="firstName" required maxLength={80} autoComplete="off" />
        </label>
        <label>
          Last name
          <input name="lastName" required maxLength={80} autoComplete="off" />
        </label>
      </div>
      <label>
        Email
        <input name="email" type="email" required placeholder="name@example.com" />
        <span className="muted hint">Where their ticket will go once ticket emails are ready.</span>
      </label>
      <label>
        Note
        <input name="note" maxLength={500} placeholder="Chaperone, sponsor, DJ…" />
      </label>
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && (
        <p className="notice" role="status" tabIndex={-1} ref={doneRef}>
          Comp ticket issued to {state.done}.
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Issuing…" : "Issue comp ticket"}
      </button>
    </form>
  );
}
