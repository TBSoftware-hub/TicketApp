/** Base URL of the TicketApp API. Set per environment; see .env.production. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000").replace(
  /\/+$/,
  "",
);

export const UNREACHABLE = "Couldn't reach TicketApp. Check your connection and try again.";

/** Thrown for any failed call; status 0 means the API couldn't be reached at all. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the API, authenticated with the staff member's session token when one is given. */
export async function api<T>(
  path: string,
  { token, method = "GET", body }: { token?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, UNREACHABLE);
  }
  if (res.status === 204) return {} as T;
  // A proxy or crash page may not be JSON; report it as an error instead of throwing.
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      typeof data === "object" && data && "error" in data && typeof data.error === "string"
        ? data.error
        : `Unexpected response (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}
