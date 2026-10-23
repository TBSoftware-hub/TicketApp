import { doorEventSchema, type DoorEvent } from "@ticketapp/shared";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PropsWithChildren } from "react";
import { api, ApiError, type ApiOptions } from "./api";
import { getItem, setItem } from "./storage";

const SESSION_KEY = "ticketapp.session";
const EVENT_KEY = "ticketapp.door-event";

export interface Staff {
  id: string;
  email: string;
  name: string;
}

export interface Session {
  token: string;
  staff: Staff;
}

interface SessionContext {
  /** True until the saved session and event have been read from the device. */
  isLoading: boolean;
  session: Session | null;
  /** The event this device is checking people in for. */
  event: DoorEvent | null;
  signIn: (session: Session) => Promise<void>;
  signOut: () => Promise<void>;
  chooseEvent: (event: DoorEvent | null) => Promise<void>;
  /** Calls the API as the signed-in staff member; an expired session signs the device out. */
  call: <T>(path: string, options?: Omit<ApiOptions, "token">) => Promise<T>;
}

const Context = createContext<SessionContext | null>(null);

export function useSession(): SessionContext {
  const value = use(Context);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

function parseSaved<T>(raw: string | null, parse: (value: unknown) => T): T | null {
  if (!raw) return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    // Saved by an older version of the app, or corrupted: start again rather than crash.
    return null;
  }
}

function parseSession(value: unknown): Session {
  const session = value as Session;
  if (typeof session?.token !== "string" || typeof session.staff?.email !== "string") {
    throw new Error("Not a saved session");
  }
  return session;
}

export function SessionProvider({ children }: PropsWithChildren) {
  const [isLoading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [event, setEvent] = useState<DoorEvent | null>(null);
  // The token in use right now, so a late answer to an earlier session's request can tell it's stale.
  const activeToken = useRef<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [savedSession, savedEvent] = await Promise.all([
          getItem(SESSION_KEY),
          getItem(EVENT_KEY),
        ]);
        const restored = parseSaved(savedSession, parseSession);
        activeToken.current = restored?.token ?? null;
        setSession(restored);
        if (restored) setEvent(parseSaved(savedEvent, (v) => doorEventSchema.parse(v)));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const chooseEvent = useCallback(async (next: DoorEvent | null) => {
    setEvent(next);
    await setItem(EVENT_KEY, next ? JSON.stringify(next) : null);
  }, []);

  const signIn = useCallback(async (next: Session) => {
    await setItem(SESSION_KEY, JSON.stringify(next));
    activeToken.current = next.token;
    setSession(next);
  }, []);

  const forget = useCallback(async () => {
    activeToken.current = null;
    setSession(null);
    setEvent(null);
    await Promise.all([setItem(SESSION_KEY, null), setItem(EVENT_KEY, null)]);
  }, []);

  const signOut = useCallback(async () => {
    const token = session?.token;
    await forget();
    // Best effort: the device forgets the token either way, so a failed call only leaves the
    // session to expire on its own.
    if (token) await api("/auth/sign-out", { token, method: "POST" }).catch(() => undefined);
  }, [session, forget]);

  const call = useCallback(
    async <T,>(path: string, options: Omit<ApiOptions, "token"> = {}) => {
      const token = session?.token;
      try {
        return await api<T>(path, { ...options, token });
      } catch (err) {
        // Only sign out if the rejected token is still the one in use: a request started before
        // a sign-out must not throw away whoever signed in since.
        if (
          err instanceof ApiError &&
          err.status === 401 &&
          token &&
          token === activeToken.current
        ) {
          await forget();
        }
        throw err;
      }
    },
    [session, forget],
  );

  const value = useMemo(
    () => ({ isLoading, session, event, signIn, signOut, chooseEvent, call }),
    [isLoading, session, event, signIn, signOut, chooseEvent, call],
  );
  return <Context value={value}>{children}</Context>;
}
