import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Config, Client } from './config.ts';
import type { Db, UserRow } from './db.ts';
import type { Keys } from './keys.ts';
import { randomToken, sha256hex } from './crypto.ts';

export const now = () => Math.floor(Date.now() / 1000);
export const SETUP_TTL = 24 * 3600;
const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export interface AppOptions {
  /** Used for back-channel logout delivery. Inject in tests. */
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  /** Delay before retry n is n × this (default 1000 ms). */
  backchannelRetryDelayMs?: number;
  /** Per-attempt timeout (default 5000 ms). */
  backchannelTimeoutMs?: number;
}

export interface AuditEntry {
  actor?: Pick<UserRow, 'id' | 'email'> | null;
  action: string;
  targetId?: string | null;
  target?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
}

const iso = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString() : null);

export function createCore(config: Config, db: Db, keys: Keys, opts: AppOptions = {}) {
  const fetchFn = opts.fetch ?? fetch;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const retryDelay = opts.backchannelRetryDelayMs ?? 1000;
  const timeout = opts.backchannelTimeoutMs ?? 5000;

  // ---------- users / apps ----------
  const getUser = (id: string) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  const getActiveUser = (id: string) => db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(id) as UserRow | undefined;
  const getUserByEmail = (email: string) => db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;

  /** App keys in clients.json order. */
  const appKeys = () => [...new Set([...config.clients.values()].map((c) => c.app))];
  const clientsOfApp = (app: string) => [...config.clients.values()].filter((c) => c.app === app);
  /** Display info for an app: the client whose id equals the app key wins, else the first one. */
  const appInfo = (app: string) => {
    const cs = clientsOfApp(app);
    const main = cs.find((c) => c.id === app) ?? cs[0];
    return { app, name: main?.name ?? app, homeUrl: main?.homeUrl ?? cs.find((c) => c.homeUrl)?.homeUrl ?? null };
  };
  const grantedApps = (userId: string) =>
    (db.prepare('SELECT app FROM user_apps WHERE user_id = ? ORDER BY app').all(userId) as { app: string }[]).map((r) => r.app);
  const setApps = (userId: string, apps: string[]) => {
    db.prepare('DELETE FROM user_apps WHERE user_id = ?').run(userId);
    for (const a of new Set(apps)) db.prepare('INSERT INTO user_apps (user_id, app) VALUES (?, ?)').run(userId, a);
  };
  /** Apps the user may use: admins get every app. */
  const effectiveApps = (u: UserRow) => (u.role === 'admin' ? appKeys() : grantedApps(u.id).filter((a) => appKeys().includes(a)));
  const hasAccess = (u: UserRow, client: Client) =>
    u.role === 'admin' || !!db.prepare('SELECT 1 FROM user_apps WHERE user_id = ? AND app = ?').get(u.id, client.app);
  const activeAdminCount = () => (db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;

  const userJson = (u: UserRow) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, hasPassword: !!u.password_hash,
    apps: grantedApps(u.id), createdAt: iso(u.created_at), lastLoginAt: iso(u.last_login_at),
  });

  // ---------- setup links ----------
  /** New one-time setup link; any older unused link for the user stops working. */
  const createSetupLink = (userId: string) => {
    const token = randomToken(32);
    db.prepare('DELETE FROM setup_tokens WHERE user_id = ? AND used_at IS NULL').run(userId);
    db.prepare('INSERT INTO setup_tokens (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha256hex(token), userId, now(), now() + SETUP_TTL);
    return `${config.issuer}/setup/${token}`;
  };

  // ---------- audit ----------
  const audit = (e: AuditEntry) => {
    db.prepare('INSERT INTO audit_log (created_at, actor_id, actor_email, action, target_id, target, ip, user_agent, detail) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(now(), e.actor?.id ?? null, e.actor?.email ?? null, e.action, e.targetId ?? null, e.target ?? null, e.ip ?? null,
        e.userAgent?.slice(0, 300) ?? null, e.detail ? JSON.stringify(e.detail) : null);
  };

  // ---------- back-channel logout ----------
  const pending = new Set<Promise<void>>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function deliver(client: Client, sub: string, sid: string) {
    const uri = client.backchannelLogoutUri!;
    const iat = now();
    const token = await new SignJWT({ sid, events: { [BACKCHANNEL_EVENT]: {} } })
      .setProtectedHeader({ alg: 'EdDSA', kid: keys.kid, typ: 'logout+jwt' })
      .setIssuer(config.issuer).setAudience(client.id).setSubject(sub)
      .setIssuedAt(iat).setExpirationTime(iat + 120).setJti(randomUUID())
      .sign(keys.signKey);
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const res = await fetchFn(uri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ logout_token: token }).toString(),
          signal: AbortSignal.timeout(timeout),
          redirect: 'manual',
        });
        await res.body?.cancel().catch(() => {});
        if (res.ok) return;
        log(`back-channel logout to ${client.id} (${uri}) failed: HTTP ${res.status} (attempt ${attempt + 1}/3)`);
      } catch (e) {
        log(`back-channel logout to ${client.id} (${uri}) failed: ${(e as Error).message} (attempt ${attempt + 1}/3)`);
      }
      if (attempt < 2) await sleep(retryDelay * (attempt + 1));
    }
  }

  /** Fire-and-forget: notify every client that got tokens in session `sid`. */
  const notifyLogout = (sid: string, sub: string) => {
    const rows = db.prepare('SELECT client_id FROM session_clients WHERE sid = ?').all(sid) as { client_id: string }[];
    for (const { client_id } of rows) {
      const client = config.clients.get(client_id);
      if (!client?.backchannelLogoutUri) continue;
      const p: Promise<void> = deliver(client, sub, sid).catch((e) => log(`back-channel logout error: ${(e as Error).message}`)).finally(() => pending.delete(p));
      pending.add(p);
    }
  };
  /** Resolves once all in-flight back-channel deliveries settled (tests, graceful shutdown). */
  const idle = async () => { while (pending.size) await Promise.allSettled([...pending]); };

  // ---------- sessions ----------
  /** End sessions: mark ended, revoke their refresh tokens, fire back-channel logout. */
  const endSessions = (sessions: { sid: string; user_id: string }[]) => {
    for (const { sid, user_id } of sessions) {
      const ended = db.prepare('UPDATE sessions SET ended_at = ? WHERE sid = ? AND ended_at IS NULL').run(now(), sid).changes;
      const revoked = db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE sid = ? AND revoked = 0').run(sid).changes;
      if (ended || revoked) notifyLogout(sid, user_id);
    }
  };
  /** Sign a user out everywhere: every session, every refresh token. */
  const endUserEverywhere = (userId: string, exceptSid?: string) => {
    const sids = db.prepare(`
      SELECT sid FROM sessions WHERE user_id = ? AND ended_at IS NULL
      UNION SELECT sid FROM refresh_tokens WHERE user_id = ? AND revoked = 0 AND sid IS NOT NULL`).all(userId, userId) as { sid: string }[];
    endSessions(sids.filter((s) => s.sid !== exceptSid).map((s) => ({ sid: s.sid, user_id: userId })));
    if (exceptSid) db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND (sid IS NULL OR sid != ?)').run(userId, exceptSid);
    else db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(userId);
  };
  const sessionEnded = (sid: string) => !!db.prepare('SELECT 1 FROM sessions WHERE sid = ? AND ended_at IS NOT NULL').get(sid);

  return {
    getUser, getActiveUser, getUserByEmail, appKeys, clientsOfApp, appInfo, grantedApps, setApps, effectiveApps, hasAccess,
    activeAdminCount, userJson, createSetupLink, audit, endSessions, endUserEverywhere, sessionEnded, idle, iso,
  };
}
export type Core = ReturnType<typeof createCore>;

/**
 * Ensure an active admin exists. On an empty DB (or a DB from before roles existed) this creates — or promotes —
 * `config.adminEmail`. If that admin still has no password, returns a fresh one-time setup link to log.
 */
export function bootstrapAdmin(config: Config, db: Db, core: Core): string | null {
  const email = config.adminEmail;
  if (!core.activeAdminCount()) {
    const existing = core.getUserByEmail(email);
    if (existing) db.prepare("UPDATE users SET role = 'admin', disabled = 0 WHERE id = ?").run(existing.id);
    else db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,NULL,'admin',?)").run(randomUUID(), email, 'Admin', now());
    core.audit({ action: 'admin_bootstrapped', target: email });
  }
  const admin = core.getUserByEmail(email);
  if (!admin || admin.role !== 'admin' || admin.disabled || admin.password_hash) return null;
  return core.createSetupLink(admin.id);
}
