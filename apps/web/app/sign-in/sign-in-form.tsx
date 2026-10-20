"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { API_URL, errorMessage, UNREACHABLE } from "../../lib/api";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

/**
 * Posts straight from the browser so the API's per-IP limit counts each person, not our server.
 */
export function SignInForm() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const sentRef = useRef<HTMLParagraphElement>(null);

  // The form (and its focused button) disappears on success, so move focus to the next step.
  useEffect(() => {
    if (status.kind === "sent") sentRef.current?.focus();
  }, [status.kind]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    setStatus({ kind: "sending" });
    try {
      const res = await fetch(`${API_URL}/auth/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(name ? { email, name } : { email }),
      });
      if (res.status === 202) return setStatus({ kind: "sent", email });
      const data: unknown = await res.json().catch(() => null);
      setStatus({ kind: "error", message: errorMessage(data) });
    } catch {
      setStatus({ kind: "error", message: UNREACHABLE });
    }
  }

  if (status.kind === "sent") {
    return (
      <p className="notice" role="status" tabIndex={-1} ref={sentRef}>
        Check <strong>{status.email}</strong> for a sign-in link. It works once and expires in 15
        minutes.
      </p>
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Your name <span className="muted">(first time only)</span>
        <input name="name" autoComplete="name" />
      </label>
      {status.kind === "error" && (
        <p className="notice error" role="alert">
          {status.message}
        </p>
      )}
      <button type="submit" disabled={status.kind === "sending"}>
        {status.kind === "sending" ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
