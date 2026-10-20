import { cookies } from "next/headers";

export const SESSION_COOKIE = "ticketapp_session";
const THIRTY_DAYS = 30 * 24 * 60 * 60;

export async function getSessionToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** The API session token lives in an httpOnly cookie, so page scripts can never read it. */
export async function setSessionToken(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: THIRTY_DAYS,
  });
}

export async function clearSessionToken() {
  (await cookies()).delete(SESSION_COOKIE);
}
