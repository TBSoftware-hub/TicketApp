"use client";

import { useActionState, useState } from "react";
import { useClearingForm } from "../../../../../../lib/use-clearing-form";
import { createPromoCode, type CreatedState } from "../../../../../actions";

export function PromoCodeForm({
  orgId,
  eventId,
  timezone,
  ticketTypes,
}: {
  orgId: string;
  eventId: string;
  timezone: string;
  ticketTypes: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState<CreatedState, FormData>(
    createPromoCode.bind(null, orgId, eventId, timezone),
    {},
  );
  const { formRef, doneRef, onSubmit } = useClearingForm(state.done, formAction);
  const [discountType, setDiscountType] = useState("PERCENT");
  const zoneName = timezone.split("/").pop()?.replace(/_/g, " ");

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onReset={() => setDiscountType("PERCENT")}
      className="stack"
    >
      <label>
        Code
        <input
          name="code"
          required
          minLength={3}
          maxLength={24}
          placeholder="EARLYBIRD"
          autoCapitalize="characters"
          className="code-input"
        />
      </label>
      <div className="row-fields">
        <label>
          Discount
          <select
            name="discountType"
            value={discountType}
            onChange={(e) => setDiscountType(e.target.value)}
          >
            <option value="PERCENT">Percent off each ticket</option>
            <option value="AMOUNT">Dollar amount off the order</option>
          </select>
        </label>
        <label>
          {discountType === "PERCENT" ? "Percent" : "Amount"}
          <span className="prefixed">
            {discountType === "AMOUNT" && <span className="muted">$</span>}
            <input
              name="discountValue"
              required
              inputMode={discountType === "PERCENT" ? "numeric" : "decimal"}
              placeholder={discountType === "PERCENT" ? "20" : "5.00"}
            />
            {discountType === "PERCENT" && <span className="muted">%</span>}
          </span>
        </label>
      </div>
      <label>
        Uses allowed
        <input name="maxUses" type="number" min={1} max={100000} placeholder="No limit" />
        <span className="muted hint">Each order that uses the code counts once.</span>
      </label>
      <div className="row-fields">
        <label>
          Works from
          <input name="validFrom" type="datetime-local" />
        </label>
        <label>
          Works until
          <input name="validUntil" type="datetime-local" />
        </label>
      </div>
      <p className="muted hint">Times are in {zoneName} time. Leave them blank for no limit.</p>
      {ticketTypes.length > 0 && (
        <fieldset className="stack">
          <legend>Applies to</legend>
          {ticketTypes.map((tt) => (
            <label key={tt.id} className="choice">
              <input type="checkbox" name="ticketTypeIds" value={tt.id} />
              {tt.name}
            </label>
          ))}
          <p className="muted hint">Leave them all unticked to apply it to every ticket type, including ones added later.</p>
        </fieldset>
      )}
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && (
        <p className="notice" role="status" tabIndex={-1} ref={doneRef}>
          Added {state.done.label}.
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add promo code"}
      </button>
    </form>
  );
}
