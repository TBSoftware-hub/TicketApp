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

/**
 * Passes a file download from the API (a PDF, say) straight through to the browser, or shows the
 * API's error as plain text.
 */
export async function apiFile(
  path: string,
  { token, method = "GET", body }: { token?: string; method?: string; body?: unknown } = {},
): Promise<Response> {
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
    console.error(`API request to ${path} failed`, err);
    return new Response(UNREACHABLE, { status: 502, headers: { "content-type": "text/plain" } });
  }
  if (!res.ok) {
    const message = errorMessage(await res.json().catch(() => null));
    return new Response(message, {
      status: res.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const headers = new Headers({ "cache-control": "private, no-store" });
  for (const name of ["content-type", "content-disposition"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(res.body, { status: 200, headers });
}
