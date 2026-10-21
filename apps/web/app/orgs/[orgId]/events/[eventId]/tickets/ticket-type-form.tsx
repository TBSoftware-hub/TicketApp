"use client";

import { MAX_GRADE, MIN_GRADE } from "@ticketapp/shared";
import { startTransition, useActionState, useState, type FormEvent } from "react";
import type { WaiverChoice } from "../../../../../../lib/waivers";
import { saveTicketType, type FormState } from "../../../../../actions";

export interface TicketTypeFormValues {
  name: string;
  price: string;
  quantity: string;
  maxPerOrder: string;
  salesStartAt: string;
  salesEndAt: string;
  studentsOnly: boolean;
  minGrade: string;
  maxGrade: string;
  requiresApproval: boolean;
  waiverIds: string[];
  /** Stored instants of an existing ticket type, so unchanged times are saved exactly as they were. */
  salesStartAtUtc?: string | null;
  salesEndAtUtc?: string | null;
}

const GRADES = Array.from({ length: MAX_GRADE - MIN_GRADE + 1 }, (_, i) => MIN_GRADE + i);

export function TicketTypeForm({
  orgId,
  eventId,
  ticketTypeId,
  timezone,
  initial,
  waivers,
}: {
  orgId: string;
  eventId: string;
  ticketTypeId: string | null;
  timezone: string;
  initial: TicketTypeFormValues;
  waivers: WaiverChoice[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    saveTicketType.bind(null, orgId, eventId, ticketTypeId, timezone),
    {},
  );
  const [studentsOnly, setStudentsOnly] = useState(initial.studentsOnly);

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
      <fieldset className="stack">
        <legend>Who can buy</legend>
        <label className="choice">
          <input
            type="radio"
            name="studentsOnly"
            value="false"
            checked={!studentsOnly}
            onChange={() => setStudentsOnly(false)}
          />
          Anyone
        </label>
        <label className="choice">
          <input
            type="radio"
            name="studentsOnly"
            value="true"
            checked={studentsOnly}
            onChange={() => setStudentsOnly(true)}
          />
          Students only
        </label>
        {studentsOnly && (
          <div className="row-fields">
            <label>
              Lowest grade
              <select name="minGrade" defaultValue={initial.minGrade}>
                <option value="">Any</option>
                {GRADES.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Highest grade
              <select name="maxGrade" defaultValue={initial.maxGrade}>
                <option value="">Any</option>
                {GRADES.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <label className="choice">
          <input
            type="checkbox"
            name="requiresApproval"
            defaultChecked={initial.requiresApproval}
          />
          Each purchase needs staff approval
        </label>
        <p className="muted hint">
          Use approval for guest passes, so staff can check a guest before their ticket is valid.
        </p>
      </fieldset>
      <fieldset className="stack-tight">
        <legend>Waivers</legend>
        {waivers.length === 0 ? (
          <p className="muted hint">
            No waivers yet. <a href={`/orgs/${orgId}/waivers/new`}>Create one</a> to have each
            attendee sign it at checkout.
          </p>
        ) : (
          <>
            <p className="muted hint">Each attendee with this ticket signs these at checkout.</p>
            {waivers.map((w) => (
              <label key={w.id} className="choice">
                <input
                  type="checkbox"
                  name="waiverIds"
                  value={w.id}
                  defaultChecked={initial.waiverIds.includes(w.id)}
                />
                {w.title}
                {w.archived && <span className="muted"> (archived)</span>}
              </label>
            ))}
          </>
        )}
      </fieldset>
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
