import { createHash, randomBytes } from "node:crypto";

/** A URL-safe random token with 256 bits of entropy. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are stored hashed so a database leak doesn't hand out working sign-in links or sessions. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
