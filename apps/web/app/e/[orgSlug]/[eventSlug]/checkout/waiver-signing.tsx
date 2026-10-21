"use client";

import type { WaiverAnswer, WaiverField } from "@ticketapp/shared";
import type { PublicWaiver } from "../../../../../lib/public-events";

export interface WaiverDraft {
  answers: Record<string, WaiverAnswer>;
  signature: string;
  agreed: boolean;
}

/** One waiver for one attendee: its wording, its questions, and a typed signature. */
export function WaiverSigning({
  waiver,
  signer,
  draft,
  onChange,
}: {
  waiver: PublicWaiver;
  /** The attendee's full name, which they type to sign. */
  signer: string;
  draft: WaiverDraft;
  onChange: (draft: WaiverDraft) => void;
}) {
  const answer = (id: string, value: WaiverAnswer) =>
    onChange({ ...draft, answers: { ...draft.answers, [id]: value } });

  return (
    <div className="waiver stack-tight">
      <strong>{waiver.title}</strong>
      <div className="waiver-text" tabIndex={0} aria-label={`Text of ${waiver.title}`}>
        {waiver.body}
      </div>
      {waiver.fields.map((field) => (
        <WaiverQuestion
          key={field.id}
          field={field}
          value={draft.answers[field.id]}
          onChange={(value) => answer(field.id, value)}
        />
      ))}
      <label>
        Signature
        <input
          required
          maxLength={170}
          autoComplete="off"
          value={draft.signature}
          placeholder={signer ? `Type ${signer}` : "Type the attendee's full name"}
          onChange={(e) => onChange({ ...draft, signature: e.target.value })}
        />
        <span className="muted hint">
          Typing {signer || "the attendee's full name"} here signs this waiver.
        </span>
      </label>
      <label className="choice">
        <input
          type="checkbox"
          required
          checked={draft.agreed}
          onChange={(e) => onChange({ ...draft, agreed: e.target.checked })}
        />
        I have read and agree to {waiver.title}
      </label>
    </div>
  );
}

function WaiverQuestion({
  field,
  value,
  onChange,
}: {
  field: WaiverField;
  value: WaiverAnswer | undefined;
  onChange: (value: WaiverAnswer) => void;
}) {
  const help = field.help && <span className="muted hint">{field.help}</span>;
  if (field.type === "CHECKBOX") {
    return (
      <label className="choice">
        <input
          type="checkbox"
          required={field.required}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
        {help}
      </label>
    );
  }
  const text = typeof value === "string" ? value : "";
  const optional = !field.required && <span className="muted"> (optional)</span>;
  return (
    <label>
      <span>
        {field.label}
        {optional}
      </span>
      {field.type === "LONG_TEXT" ? (
        <textarea
          rows={3}
          maxLength={5000}
          required={field.required}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === "CHOICE" ? (
        <select required={field.required} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          required={field.required}
          maxLength={field.type === "TEXT" ? 500 : 254}
          type={
            field.type === "DATE"
              ? "date"
              : field.type === "EMAIL"
                ? "email"
                : field.type === "PHONE"
                  ? "tel"
                  : "text"
          }
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help}
    </label>
  );
}
