"use client";

import { useActionState } from "react";
import { importRoster, type RosterState } from "../../../actions";

export function RosterForm({ orgId, replacing }: { orgId: string; replacing: boolean }) {
  const [state, formAction, pending] = useActionState<RosterState, FormData>(
    importRoster.bind(null, orgId),
    {},
  );
  return (
    <form action={formAction} className="stack">
      <label>
        Roster CSV
        <input name="file" type="file" accept=".csv,text/csv" required />
      </label>
      {state.error && (
        <div className="notice error" role="alert">
          <p>{state.error}</p>
          {state.problems && (
            <ul>
              {state.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {state.imported !== undefined && !pending && (
        <p className="notice" role="status">
          Imported {state.imported.toLocaleString("en-US")}{" "}
          {state.imported === 1 ? "student" : "students"}.
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Importing…" : replacing ? "Replace the roster" : "Import"}
      </button>
    </form>
  );
}
