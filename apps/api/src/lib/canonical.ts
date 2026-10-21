import { createHash } from "node:crypto";

/** JSON with object keys sorted, since Postgres doesn't keep them in the order they were saved. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/** SHA-256 of exactly what a signer was shown: the waiver's title, wording and questions. */
export function waiverDocumentHash(waiver: { title: string; body: string; fields: unknown }) {
  const { title, body, fields } = waiver;
  return createHash("sha256").update(canonical({ title, body, fields })).digest("hex");
}
