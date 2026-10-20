"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import { saveTicketType, type FormState } from "../../../../../actions";

export interface TicketTypeFormValues {
  name: string;
  price: string;
  quantity: string;
  maxPerOrder: string;
  salesStartAt: string;
  salesEndAt: string;
  /** Stored instants of an existing ticket type, so unchanged times are saved exactly as they were. */
  salesStartAtUtc?: string | null;
  salesEndAtUtc?: string | null;
}

export function TicketTypeForm({
  orgId,
  eventId,
  ticketTypeId,
  timezone,
  initial,
}: {
  orgId: string;
  eventId: string;
  ticketTypeId: string | null;
  timezone: string;
  initial: TicketTypeFormValues;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    saveTicketType.bind(null, orgId, eventId, ticketTypeId, timezone),
    {},
  );

  // Submitting through onSubmit skips React's automatic form reset, so a failed save keeps
  // everything the person typed.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  const zoneName = timezone.split("/").pop()?.replace(/_/g, " ");

  return (
    <form onSubmit={onSubmit} className="stack">
      {initial.salesStartAtUtc && (
        <>
          <input type="hidden" name="salesStartAtOriginal" value={initial.salesStartAt} />
          <input type="hidden" name="salesStartAtOriginalUtc" value={initial.salesStartAtUtc} />
        </>
      )}
      {initial.salesEndAtUtc && (
        <>
          <input type="hidden" name="salesEndAtOriginal" value={initial.salesEndAt} />
          <input type="hidden" name="salesEndAtOriginalUtc" value={initial.salesEndAtUtc} />
        </>
      )}
      <label>
        Name
        <input
          name="name"
          required
          maxLength={80}
          defaultValue={initial.name}
          placeholder="General admission"
        />
      </label>
      <div className="row-fields">
        <label>
          Price
          <span className="prefixed">
            <span className="muted">$</span>
            <input
              name="price"
              required
              inputMode="decimal"
              defaultValue={initial.price}
              placeholder="15.00"
            />
          </span>
          <span className="muted hint">Enter 0 for a free ticket.</span>
        </label>
        <label>
          Tickets available
          <input
            name="quantity"
            type="number"
            min={1}
            max={100000}
            defaultValue={initial.quantity}
            placeholder="No limit"
          />
          <span className="muted hint">The event capacity still applies.</span>
        </label>
      </div>
      <label>
        Most per order
        <input
          name="maxPerOrder"
          type="number"
          required
          min={1}
          max={50}
          defaultValue={initial.maxPerOrder}
        />
      </label>
      <div className="row-fields">
        <label>
          Sales open
          <input name="salesStartAt" type="datetime-local" defaultValue={initial.salesStartAt} />
        </label>
        <label>
          Sales close
          <input name="salesEndAt" type="datetime-local" defaultValue={initial.salesEndAt} />
        </label>
      </div>
      <p className="muted hint">
        Times are in {zoneName} time. Leave them blank to sell for as long as the event is on sale.
      </p>
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : ticketTypeId ? "Save changes" : "Add ticket type"}
      </button>
    </form>
  );
}
