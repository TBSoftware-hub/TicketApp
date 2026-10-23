"use client";

import { slugify } from "@ticketapp/shared";
import { startTransition, useActionState, useState, type FormEvent } from "react";
import { saveEvent, type FormState } from "../../../actions";

export interface EventFormValues {
  name: string;
  slug: string;
  venue: string;
  description: string;
  startsAt: string;
  endsAt: string;
  capacity: string;
  reentryAllowed: boolean;
  /** Stored instants of an existing event, so unchanged times are saved exactly as they were. */
  startsAtUtc?: string;
  endsAtUtc?: string;
}

export function EventForm({
  orgId,
  eventId,
  timezone,
  initial,
}: {
  orgId: string;
  eventId: string | null;
  timezone: string;
  initial: EventFormValues;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    saveEvent.bind(null, orgId, eventId, timezone),
    {},
  );
  const [slug, setSlug] = useState(initial.slug);
  // A new event's web address follows its name until someone edits it; an existing one stays put
  // so shared links keep working.
  const [slugEdited, setSlugEdited] = useState(eventId !== null);

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
      {initial.startsAtUtc && (
        <>
          <input type="hidden" name="startsAtOriginal" value={initial.startsAt} />
          <input type="hidden" name="startsAtOriginalUtc" value={initial.startsAtUtc} />
          <input type="hidden" name="endsAtOriginal" value={initial.endsAt} />
          <input type="hidden" name="endsAtOriginalUtc" value={initial.endsAtUtc} />
        </>
      )}
      <label>
        Name
        <input
          name="name"
          required
          minLength={2}
          maxLength={120}
          defaultValue={initial.name}
          placeholder="Homecoming Dance"
          onChange={(e) => !slugEdited && setSlug(slugify(e.target.value))}
        />
      </label>
      <label>
        Web address
        <span className="prefixed">
          <span className="muted">…/</span>
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
      <div className="row-fields">
        <label>
          Starts
          <input name="startsAt" type="datetime-local" required defaultValue={initial.startsAt} />
        </label>
        <label>
          Ends
          <input name="endsAt" type="datetime-local" required defaultValue={initial.endsAt} />
        </label>
      </div>
      <p className="muted hint">Times are in {zoneName} time.</p>
      <div className="row-fields">
        <label>
          Venue
          <input name="venue" maxLength={200} defaultValue={initial.venue} placeholder="Main Gym" />
        </label>
        <label>
          Capacity
          <input
            name="capacity"
            type="number"
            min={1}
            max={100000}
            defaultValue={initial.capacity}
            placeholder="No limit"
          />
        </label>
      </div>
      <label className="choice">
        <input type="checkbox" name="reentryAllowed" defaultChecked={initial.reentryAllowed} />
        Let people back in after they check out
      </label>
      <p className="muted hint">
        Leave this off for a lock-in, such as an after-prom: once someone checks out at the door,
        the app won&apos;t let them back in unless staff give a reason.
      </p>
      <label>
        Description
        <textarea
          name="description"
          rows={5}
          maxLength={5000}
          defaultValue={initial.description}
          placeholder="Dress code, what to bring, who can attend…"
        />
      </label>
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : eventId ? "Save changes" : "Create event"}
      </button>
    </form>
  );
}
