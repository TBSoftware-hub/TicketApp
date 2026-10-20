"use client";

import { roleSchema } from "@ticketapp/shared";
import { startTransition, useActionState, useEffect, useRef, type FormEvent } from "react";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "../../../../lib/roles";
import { inviteMember, type InviteState } from "../../../actions";

export function InviteForm({
  orgId,
  canInviteOwners,
}: {
  orgId: string;
  canInviteOwners: boolean;
}) {
  const [state, formAction, pending] = useActionState<InviteState, FormData>(
    inviteMember.bind(null, orgId),
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const sentRef = useRef<HTMLParagraphElement>(null);
  const roles = roleSchema.options.filter((r) => canInviteOwners || r !== "OWNER");

  // Clear the email only after a successful send, and announce it.
  useEffect(() => {
    if (state.sentTo) {
      const email = formRef.current?.querySelector<HTMLInputElement>("input[name=email]");
      if (email) email.value = "";
      sentRef.current?.focus();
    }
  }, [state]);

  // Submitting through onSubmit skips React's automatic form reset, so a refused address stays
  // in the field to be corrected.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="stack">
      <label>
        Email
        <input name="email" type="email" required placeholder="name@school.org" />
      </label>
      <label>
        Role
        <select name="role" defaultValue="DOOR_STAFF">
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}: {ROLE_DESCRIPTIONS[r]}
            </option>
          ))}
        </select>
      </label>
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      {state.sentTo && !pending && (
        <p className="notice" role="status" tabIndex={-1} ref={sentRef}>
          Invitation sent to {state.sentTo}.
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send invitation"}
      </button>
    </form>
  );
}
