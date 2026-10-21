"use client";

import { useFormStatus } from "react-dom";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="link" disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

/** Cancels an order once staff confirm, since a refund can't be taken back. */
export function CancelOrderButton({
  action,
  fields,
  label,
  question,
}: {
  action: (formData: FormData) => Promise<void>;
  fields: Record<string, string>;
  label: string;
  question: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(question)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Submit label={label} />
    </form>
  );
}
