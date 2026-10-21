"use client";

import { MAX_DOOR_SALE_TICKETS } from "@ticketapp/shared";
import { useActionState, useEffect, useState } from "react";
import { formatPrice } from "../../../../../../lib/ticket-types";
import { useClearingForm } from "../../../../../../lib/use-clearing-form";
import { recordDoorSale, type CreatedState } from "../../../../../actions";

export function DoorSaleForm({
  orgId,
  eventId,
  ticketTypes,
}: {
  orgId: string;
  eventId: string;
  ticketTypes: { id: string; name: string; priceCents: number }[];
}) {
  const [state, formAction, pending] = useActionState<CreatedState, FormData>(
    recordDoorSale.bind(null, orgId, eventId),
    {},
  );
  const { formRef, doneRef, onSubmit } = useClearingForm(state.done, formAction);
  const [typeId, setTypeId] = useState(ticketTypes[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  // One key per sale: a resend after a lost response is recognised, and the next sale gets a new
  // key once this one is recorded.
  const [saleKey, setSaleKey] = useState(() => crypto.randomUUID());
  const soldId = state.done?.id;
  useEffect(() => {
    if (soldId) setSaleKey(crypto.randomUUID());
  }, [soldId]);
  const price = ticketTypes.find((tt) => tt.id === typeId)?.priceCents ?? 0;
  const reset = () => {
    setTypeId(ticketTypes[0]?.id ?? "");
    setQuantity(1);
  };

  return (
    <form ref={formRef} onSubmit={onSubmit} onReset={reset} className="stack">
      <input type="hidden" name="saleKey" value={saleKey} />
      <div className="row-fields">
        <label>
          Ticket type
          <select
            name="ticketTypeId"
            required
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
          >
            {ticketTypes.map((tt) => (
              <option key={tt.id} value={tt.id}>
                {tt.name} · {formatPrice(tt.priceCents)}
              </option>
            ))}
          </select>
        </label>
        <label>
          How many
          <input
            name="quantity"
            type="number"
            inputMode="numeric"
            required
            min={1}
            max={MAX_DOOR_SALE_TICKETS}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
      </div>
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
        Email <span className="muted">(optional)</span>
        <input name="email" type="email" placeholder="name@example.com" autoComplete="off" />
        <span className="muted hint">With an email, the buyer gets their tickets to keep.</span>
      </label>
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && (
        <p className="notice" role="status" tabIndex={-1} ref={doneRef}>
          Sold {state.done.label}.
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending
          ? "Recording…"
          : `Record cash sale · ${formatPrice(price * (Number.isFinite(quantity) ? quantity : 0))}`}
      </button>
    </form>
  );
}
