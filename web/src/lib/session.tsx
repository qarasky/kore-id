import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import type { SessionInfo, User } from "./types";

type SessionState = {
  /** undefined while the first /api/session is loading. */
  user: User | null | undefined;
  csrf: string | null;
  error: unknown;
  refresh: () => Promise<User | null>;
  setUser: (u: User) => void;
  /** POST /api/logout, then the sign-in page. */
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children, initial }: { children: ReactNode; initial?: SessionInfo }) {
  const [user, setUser] = useState<User | null | undefined>(initial ? initial.user : undefined);
  const [csrf, setCsrfState] = useState<string | null>(initial?.csrf ?? null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.session();
      setUser(s.user);
      setCsrfState(s.csrf);
      setError(null);
      return s.user;
    } catch (e) {
      setError(e);
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!initial) void refresh();
  }, [initial, refresh]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      window.location.assign("/login?signed_out=1");
    }
  }, []);

  return <Ctx value={{ user, csrf, error, refresh, setUser, signOut }}>{children}</Ctx>;
}

export function useSession(): SessionState {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
