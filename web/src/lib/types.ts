// Shapes of the Kore ID JSON API (src/api.ts on the server). Times are ISO strings or null.
export type Role = "admin" | "user";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  hasPassword: boolean;
  /** App keys granted explicitly. Admins can use every app regardless. */
  apps: string[];
  createdAt: string | null;
  lastLoginAt: string | null;
};

export type Session = {
  id: string;
  current: boolean;
  createdAt: string | null;
  lastSeenAt: string | null;
  expiresAt: string | null;
  ip: string | null;
  userAgent: string | null;
  apps: { app: string; name: string }[];
};

export type SessionInfo = {
  user: User | null;
  csrf: string;
  /** Present when /api/session was asked about a client_id. */
  app?: { app: string; name: string } | null;
};

export type MyApp = { app: string; name: string; homeUrl: string | null };

export type AdminClient = {
  id: string;
  name: string;
  app: string;
  public: boolean;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  homeUrl: string | null;
  backchannelLogoutUri: string | null;
};

export type AdminApp = { app: string; name: string; homeUrl: string | null; userCount: number; clients: AdminClient[] };

export type AuditEntry = {
  id: number;
  time: string | null;
  actor: { id: string | null; email: string | null } | null;
  action: string;
  target: { id: string | null; label: string | null } | null;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown> | null;
};
