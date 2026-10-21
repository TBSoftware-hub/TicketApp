"use client";

import type { WaiverAnswer, WaiverField } from "@ticketapp/shared";
import { useState, type FormEvent } from "react";
import { API_URL, errorMessage, UNREACHABLE } from "../../lib/api";
import type { GuardianRequest } from "../../lib/guardian-signatures";

/** Posts straight from the browser so the API's per-IP limit counts each guardian, not our server. */
export function GuardianSignForm({ token, initial }: { token: string; initial: GuardianRequest }) {
  const [request, setRequest] = useState(initial);
  const [signature, setSignature] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { attendee, waivers } = request;
  const titles = waivers.map((w) => w.title).join(", ");

  if (request.signedAt) {
    return (
      <p className="notice" role="status">
        Signed by {request.signerName ?? request.guardianName} on{" "}
        {new Intl.DateTimeFormat("en-US", {
          timeZone: request.event.timezone,
          dateStyle: "long",
        }).format(new Date(request.signedAt))}
        . Thank you. There&apos;s nothing else to do.
      </p>
    );
  }
  if (request.expired) {
    return (
      <p className="notice" role="status">
        {request.event.name} is over, so there&apos;s nothing left to sign.
      </p>
    );
  }

  async function onSubmit(submit: FormEvent<HTMLFormElement>) {
    submit.preventDefault();
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/public/guardian-signatures/sign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, signature, agreed }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (res.ok && data && typeof data === "object" && "request" in data) {
        setRequest((data as { request: GuardianRequest }).request);
      } else {
        setError(
          res.status === 429 ? "Too many tries. Wait a minute and try again." : errorMessage(data),
        );
      }
    } catch {
      setError(UNREACHABLE);
    }
    setSending(false);
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <p>
        Hi {request.guardianName}. {attendee.firstName} is under 18, so a parent or guardian needs
        to sign {waivers.length === 1 ? "this waiver" : "these waivers"} as well.
      </p>
      {waivers.map((w) => (
        <section key={w.id} className="waiver stack-tight">
          <strong>{w.title}</strong>
          <div className="waiver-text" tabIndex={0} aria-label={`Text of ${w.title}`}>
            {w.body}
          </div>
          {w.fields.length > 0 && (
            <dl className="facts">
              {w.fields.map((field) => (
                <div key={field.id}>
                  <dt>{field.label}</dt>
                  <dd>{answerText(field, w.answers[field.id])}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}
      {waivers.some((w) => w.fields.length > 0) && (
        <p className="muted hint">
          The answers above were given for {attendee.firstName} when the ticket was bought.
        </p>
      )}
      <label>
        Signature
        <input
          required
          minLength={2}
          maxLength={170}
          autoComplete="off"
          value={signature}
          placeholder="Type your full name"
          onChange={(e) => setSignature(e.target.value)}
        />
        <span className="muted hint">
          Typing your full name here signs as {attendee.firstName}&apos;s parent or guardian.
        </span>
      </label>
      <label className="choice">
        <input
          type="checkbox"
          required
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        I am {attendee.firstName}&apos;s parent or legal guardian, and I have read and agree to{" "}
        {titles}
      </label>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={sending}>
        {sending ? "Signing…" : "Sign"}
      </button>
    </form>
  );
}

function answerText(field: WaiverField, answer: WaiverAnswer | undefined) {
  if (field.type === "CHECKBOX") return answer === true ? "Yes" : "No";
  return typeof answer === "string" && answer ? answer : "Not answered";
}
