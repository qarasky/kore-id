// The one way the SPA talks to Kore ID: same-origin JSON, cookie session, CSRF header on every non-GET.
import type { AdminApp, AuditEntry, MyApp, Session, SessionInfo, User } from "./types";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let csrf: string | null = null;
/** Called on 401 from an authenticated endpoint. Default: go to /login. */
let onUnauthorized: () => void = () => {
  window.location.assign("/login");
};

export function setCsrf(token: string | null) {
  csrf = token;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function fetchSession(clientId?: string): Promise<SessionInfo> {
  const q = clientId ? `?client_id=${encodeURIComponent(clientId)}` : "";
  const s = (await request("GET", `/session${q}`, undefined, { retry: false })) as SessionInfo;
  csrf = s.csrf;
  return s;
}

type Options = { retry?: boolean; /** Don't redirect on 401 (sign-in forms). */ allow401?: boolean };

async function request(method: string, path: string, body?: unknown, o: Options = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    if (!csrf) await fetchSession();
    headers["x-csrf-token"] = csrf ?? "";
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Couldn't reach Kore ID.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return data;
  const err = (data ?? {}) as { error?: string; message?: string };
  const code = err.error ?? (res.status >= 500 ? "server_error" : "unknown");
  // The CSRF cookie can rotate (new browser session): fetch a fresh token and try once more.
  if (code === "csrf_failed" && o.retry !== false) {
    await fetchSession();
    return request(method, path, body, { ...o, retry: false });
  }
  if (res.status === 401 && code === "unauthorized" && !o.allow401) onUnauthorized();
  throw new ApiError(res.status, code, err.message ?? `HTTP ${res.status}`);
}

const get = <T>(path: string) => request("GET", path) as Promise<T>;
const send = <T>(method: string, path: string, body?: unknown, o?: Options) => request(method, path, body, o) as Promise<T>;

export const api = {
  session: fetchSession,
  login: (b: { email: string; password: string; returnTo?: string }) =>
    send<{ redirect: string }>("POST", "/login", b, { allow401: true }),
  logout: () => send<{ ok: true }>("POST", "/logout"),
  setupInfo: (token: string) => get<{ email: string; name: string }>(`/setup/${encodeURIComponent(token)}`),
  setup: (token: string, password: string) =>
    send<{ redirect: string }>("POST", `/setup/${encodeURIComponent(token)}`, { password }, { allow401: true }),

  me: () => get<{ user: User }>("/me"),
  updateMe: (name: string) => send<{ user: User }>("PATCH", "/me", { name }),
  changePassword: (current: string, next: string) => send<{ ok: true }>("POST", "/me/password", { current, next }),
  myApps: () => get<{ apps: MyApp[] }>("/me/apps"),
  mySessions: () => get<{ sessions: Session[] }>("/me/sessions"),
  revokeSession: (id: string) => send<{ ok: true }>("DELETE", `/me/sessions/${encodeURIComponent(id)}`),
  revokeAllSessions: () => send<{ ok: true }>("POST", "/me/sessions/revoke-all"),

  users: (q = "") => get<{ users: User[] }>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createUser: (b: { name: string; email: string; role: string; apps: string[] }) =>
    send<{ user: User; setupUrl: string }>("POST", "/admin/users", b),
  user: (id: string) => get<{ user: User; sessions: Session[] }>(`/admin/users/${encodeURIComponent(id)}`),
  updateUser: (id: string, b: Partial<Pick<User, "name" | "email" | "role" | "disabled" | "apps">>) =>
    send<{ user: User }>("PATCH", `/admin/users/${encodeURIComponent(id)}`, b),
  deleteUser: (id: string) => send<{ ok: true }>("DELETE", `/admin/users/${encodeURIComponent(id)}`),
  resetUser: (id: string) => send<{ setupUrl: string }>("POST", `/admin/users/${encodeURIComponent(id)}/reset`),
  signOutUser: (id: string) => send<{ ok: true }>("POST", `/admin/users/${encodeURIComponent(id)}/signout`),
  apps: () => get<{ apps: AdminApp[] }>("/admin/apps"),
  audit: (p: { cursor?: number | null; limit?: number; user?: string; action?: string } = {}) => {
    const q = new URLSearchParams();
    if (p.cursor) q.set("cursor", String(p.cursor));
    if (p.limit) q.set("limit", String(p.limit));
    if (p.user) q.set("user", p.user);
    if (p.action) q.set("action", p.action);
    const s = q.toString();
    return get<{ entries: AuditEntry[]; nextCursor: number | null }>(`/admin/audit${s ? `?${s}` : ""}`);
  },
};
