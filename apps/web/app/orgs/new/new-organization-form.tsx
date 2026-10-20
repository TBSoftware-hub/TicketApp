"use client";

import { slugify } from "@ticketapp/shared";
import { startTransition, useActionState, useState, type FormEvent } from "react";
import { createOrganization, type FormState } from "../../actions";

const TIMEZONES = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
] as const;

export function NewOrganizationForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(createOrganization, {});
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  // Submitting through onSubmit skips React's automatic form reset, so a failed attempt (say, a
  // taken web address) keeps everything the person typed and chose.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={onSubmit} className="stack">
      <label>
        Name
        <input
          name="name"
          required
          minLength={2}
          maxLength={120}
          placeholder="Lincoln High School PTSA"
          onChange={(e) => !slugEdited && setSlug(slugify(e.target.value))}
        />
      </label>
      <label>
        Web address
        <span className="prefixed">
          <span className="muted">tickets/</span>
          <input
            name="slug"
            required
            value={slug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value);
            }}
          />
        </span>
      </label>
      <label>
        Type
        <select name="type" defaultValue="SCHOOL">
          <option value="SCHOOL">School</option>
          <option value="COMMITTEE">Parent or event committee</option>
          <option value="NONPROFIT">Nonprofit</option>
        </select>
      </label>
      <label>
        Time zone
        <select name="timezone" defaultValue="America/New_York">
          {TIMEZONES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {state.error && <p className="notice error">{state.error}</p>}
      <button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}
