/** Base URL of the TicketApp API. Set per environment; see .env.production. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(
  /\/+$/,
  "",
);

export const UNREACHABLE = "Couldn't reach TicketApp. Check your connection and try again.";

export interface ApiResult<T> {
  status: number;
  data: T | { error: string };
}

/** Server-side call to the API, authenticated with the signed-in user's session token. */
export async function api<T>(
  path: string,
  { token, method = "GET", body }: { token?: string; method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (err) {
    // Status 0 means the API couldn't be reached at all; callers show a retryable error.
    console.error(`API request to ${path} failed`, err);
    return { status: 0, data: { error: UNREACHABLE } };
  }
  if (res.status === 204) return { status: res.status, data: {} as T };
  // A proxy or crash page may not be JSON; report it as an error instead of throwing.
  const data = (await res
    .json()
    .catch(() => ({ error: `Unexpected response (${res.status})` }))) as T | { error: string };
  return { status: res.status, data };
}

export function errorMessage(data: unknown, fallback = "Something went wrong. Try again.") {
  return typeof data === "object" && data && "error" in data && typeof data.error === "string"
    ? data.error
    : fallback;
}
