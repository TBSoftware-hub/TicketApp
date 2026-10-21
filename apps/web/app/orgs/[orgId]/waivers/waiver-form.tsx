"use client";

import {
  MAX_WAIVER_FIELDS,
  WAIVER_FIELD_TYPE_LABELS,
  waiverFieldTypeSchema,
  type WaiverField,
  type WaiverFieldType,
} from "@ticketapp/shared";
import { startTransition, useActionState, useState, type FormEvent } from "react";
import { saveWaiver, type FormState } from "../../../actions";

export interface WaiverFormValues {
  title: string;
  body: string;
  requiresGuardianForMinors: boolean;
  fields: WaiverField[];
}

/** A question while it's being edited; choices are typed one per line. */
interface Draft {
  id: string;
  label: string;
  type: WaiverFieldType;
  required: boolean;
  help: string;
  choices: string;
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

const toDraft = (f: WaiverField): Draft => ({
  id: f.id,
  label: f.label,
  type: f.type,
  required: f.required,
  help: f.help ?? "",
  choices: (f.options ?? []).join("\n"),
});

const fromDraft = (d: Draft) => ({
  id: d.id,
  label: d.label,
  type: d.type,
  required: d.required,
  help: d.help.trim() || null,
  ...(d.type === "CHOICE"
    ? {
        options: d.choices
          .split("\n")
          .map((c) => c.trim())
          .filter(Boolean),
      }
    : {}),
});

export function WaiverForm({
  orgId,
  waiverId,
  version,
  initial,
}: {
  orgId: string;
  waiverId: string | null;
  version: number | null;
  initial: WaiverFormValues;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    saveWaiver.bind(null, orgId, waiverId, version),
    {},
  );
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [guardian, setGuardian] = useState(initial.requiresGuardianForMinors);
  const [drafts, setDrafts] = useState<Draft[]>(() => initial.fields.map(toDraft));

  const change = (id: string, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const move = (index: number, by: -1 | 1) =>
    setDrafts((ds) => {
      const next = [...ds];
      const [d] = next.splice(index, 1);
      next.splice(index + by, 0, d!);
      return next;
    });
  const add = () =>
    setDrafts((ds) => [
      ...ds,
      { id: newId(), label: "", type: "TEXT", required: true, help: "", choices: "" },
    ]);

  // Submitting through onSubmit skips React's automatic form reset, so a failed save keeps
  // everything the person typed.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("fields", JSON.stringify(drafts.map(fromDraft)));
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={onSubmit} className="stack">
      <label>
        Title
        <input
          name="title"
          required
          minLength={2}
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Field Trip Permission and Waiver"
        />
      </label>
      <label>
        What people agree to
        <textarea
          name="body"
          required
          rows={10}
          maxLength={20000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="I understand that taking part involves risks…"
        />
      </label>
      <label className="choice">
        <input
          type="checkbox"
          name="requiresGuardianForMinors"
          checked={guardian}
          onChange={(e) => setGuardian(e.target.checked)}
        />
        A parent or guardian signs for anyone under 18
      </label>

      <section className="stack">
        <div className="section-head">
          <h2>Questions</h2>
        </div>
        <p className="muted hint">
          Everyone who signs gives their full name and signature, and the date is recorded. Add
          anything else you need to know.
        </p>
        {drafts.map((d, i) => (
          <fieldset key={d.id} className="card stack-tight">
            <legend>Question {i + 1}</legend>
            <div className="row-fields">
              <label>
                Question
                <input
                  value={d.label}
                  required
                  maxLength={200}
                  onChange={(e) => change(d.id, { label: e.target.value })}
                  placeholder="Allergies or medical needs"
                />
              </label>
              <label>
                Answer type
                <select
                  value={d.type}
                  onChange={(e) => change(d.id, { type: e.target.value as WaiverFieldType })}
                >
                  {waiverFieldTypeSchema.options.map((type) => (
                    <option key={type} value={type}>
                      {WAIVER_FIELD_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {d.type === "CHOICE" && (
              <label>
                Choices, one per line
                <textarea
                  rows={4}
                  value={d.choices}
                  onChange={(e) => change(d.id, { choices: e.target.value })}
                  placeholder={"Small\nMedium\nLarge"}
                />
              </label>
            )}
            <label>
              Help text <span className="muted hint">(optional)</span>
              <input
                value={d.help}
                maxLength={300}
                onChange={(e) => change(d.id, { help: e.target.value })}
              />
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={d.required}
                onChange={(e) => change(d.id, { required: e.target.checked })}
              />
              {d.type === "CHECKBOX" ? "Must be ticked to sign" : "Required"}
            </label>
            <span className="links">
              <button type="button" className="link" disabled={i === 0} onClick={() => move(i, -1)}>
                Move up
              </button>
              <button
                type="button"
                className="link"
                disabled={i === drafts.length - 1}
                onClick={() => move(i, 1)}
              >
                Move down
              </button>
              <button
                type="button"
                className="link"
                onClick={() => setDrafts((ds) => ds.filter((x) => x.id !== d.id))}
              >
                Remove
              </button>
            </span>
          </fieldset>
        ))}
        {drafts.length < MAX_WAIVER_FIELDS && (
          <p>
            <button type="button" className="secondary" onClick={add}>
              Add a question
            </button>
          </p>
        )}
      </section>

      <section className="stack">
        <h2>Preview</h2>
        <WaiverPreview
          title={title}
          body={body}
          guardian={guardian}
          fields={drafts.map(fromDraft)}
        />
      </section>

      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : waiverId ? "Save changes" : "Create waiver"}
      </button>
    </form>
  );
}

/** Roughly what a signer will see. Nothing in it can be filled in. */
function WaiverPreview({
  title,
  body,
  guardian,
  fields,
}: {
  title: string;
  body: string;
  guardian: boolean;
  fields: ReturnType<typeof fromDraft>[];
}) {
  const star = (required: boolean) => (required ? " *" : "");
  return (
    <div className="card stack" aria-label="Preview of the waiver">
      <strong>{title || "Untitled waiver"}</strong>
      <p className="description">{body || "The waiver's wording goes here."}</p>
      {fields.map((f) => (
        <div key={f.id} className="stack-tight">
          {f.type === "CHECKBOX" ? (
            <label className="choice">
              <input type="checkbox" disabled />
              {f.label || "Untitled question"}
              {star(f.required)}
            </label>
          ) : (
            <label>
              {f.label || "Untitled question"}
              {star(f.required)}
              {f.type === "LONG_TEXT" ? (
                <textarea rows={3} disabled />
              ) : f.type === "CHOICE" ? (
                <select disabled>
                  {(f.options ?? []).map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  disabled
                  type={
                    f.type === "DATE"
                      ? "date"
                      : f.type === "EMAIL"
                        ? "email"
                        : f.type === "PHONE"
                          ? "tel"
                          : "text"
                  }
                />
              )}
            </label>
          )}
          {f.help && <span className="muted hint">{f.help}</span>}
        </div>
      ))}
      <label>
        Full name *
        <input disabled />
      </label>
      <label>
        Signature *
        <input disabled placeholder="Type your full name to sign" />
      </label>
      {guardian && (
        <p className="muted hint">
          If the attendee is under 18, a parent or guardian is asked to sign as well.
        </p>
      )}
    </div>
  );
}
