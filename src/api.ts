// JSON API for the web UI (spec §4). Same-origin, cookie session, double-submit CSRF on every non-GET.
import { Hono, type Context } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Db, UserRow, SessionRow, Role } from './db.ts';
import type { Core } from './core.ts';
import type { CurrentSession, RateLimiter } from './app.ts';
import { hashPassword, verifyPassword, DUMMY_HASH, sha256hex, safeEqual } from './crypto.ts';
import { now } from './core.ts';

export interface ApiDeps {
  config: Config;
  db: Db;
  core: Core;
  ip: (c: Context) => string;
  ua: (c: Context) => string | null;
  csrfToken: (c: Context) => string;
  currentSession: (c: Context) => CurrentSession | undefined;
  startSession: (c: Context, user: UserRow) => string;
  endCurrentSession: (c: Context) => SessionRow | undefined;
  safeReturnTo: (v: unknown) => string;
  loginLimiter: RateLimiter;
  setupLimiter: RateLimiter;
}

type Status = 400 | 401 | 403 | 404 | 409 | 429;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerApi(app: Hono, d: ApiDeps) {
  const { config, db, core } = d;
  const api = new Hono();
  const fail = (c: Context, status: Status, error: string, message: string) => c.json({ error, message }, status);
  const meta = (c: Context) => ({ ip: d.ip(c), userAgent: d.ua(c) });

  // CSRF: double-submit header on every non-GET.
  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const cookie = getCookie(c, 'kore_csrf');
      const header = c.req.header('x-csrf-token');
      if (!cookie || !header || !safeEqual(cookie, header)) return fail(c, 403, 'csrf_failed', 'Missing or invalid CSRF token. Reload the page and try again.');
    }
    await next();
  });

  const readBody = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    } catch { return {}; }
  };

  type Handler = (c: Context, cur: CurrentSession) => Response | Promise<Response>;
  const authed = (h: Handler) => (c: Context) => {
    const cur = d.currentSession(c);
    return cur ? h(c, cur) : fail(c, 401, 'unauthorized', 'Sign in required.');
  };
  const admin = (h: Handler) => authed((c, cur) => (cur.user.role === 'admin' ? h(c, cur) : fail(c, 403, 'forbidden', 'Administrator access required.')));

  // ---------- validation ----------
  const vEmail = (v: unknown) => {
    const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
  };
  const vName = (v: unknown) => {
    const n = typeof v === 'string' ? v.trim() : '';
    return n && n.length <= 100 ? n : null;
  };
  const vPassword = (v: unknown) => (typeof v === 'string' && v.length >= 10 && v.length <= 1024 ? v : null);
  const vRole = (v: unknown): Role | null => (v === 'admin' || v === 'user' ? v : null);
  const vApps = (v: unknown) => {
    if (!Array.isArray(v)) return null;
    const known = core.appKeys();
    return v.every((a) => typeof a === 'string' && known.includes(a)) ? [...new Set(v as string[])] : null;
  };

  const sessionJson = (s: SessionRow, currentSid?: string) => {
    const clients = (db.prepare('SELECT client_id FROM session_clients WHERE sid = ?').all(s.sid) as { client_id: string }[])
      .map((r) => config.clients.get(r.client_id)).filter((x) => !!x);
    const apps = [...new Set(clients.map((cl) => cl.app))].map((a) => ({ app: a, name: core.appInfo(a).name }));
    return {
      id: s.sid, current: s.sid === currentSid, createdAt: core.iso(s.created_at), lastSeenAt: core.iso(s.last_seen_at),
      expiresAt: core.iso(s.expires_at), ip: s.ip, userAgent: s.user_agent, apps,
    };
  };
  const activeSessions = (userId: string) =>
    db.prepare('SELECT * FROM sessions WHERE user_id = ? AND ended_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(userId, now()) as unknown as SessionRow[];

  // ---------- session / login ----------
  // ?client_id= also names the app being signed in to (sign-in and "no access" screens). Names aren't secret.
  api.get('/session', (c) => {
    const cur = d.currentSession(c);
    const clientId = c.req.query('client_id');
    const client = clientId ? config.clients.get(clientId) : undefined;
    return c.json({
      user: cur ? core.userJson(cur.user) : null, csrf: d.csrfToken(c),
      ...(clientId !== undefined && { app: client ? { app: client.app, name: core.appInfo(client.app).name } : null }),
    });
  });

  api.post('/login', async (c) => {
    const b = await readBody(c);
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const key = `${d.ip(c)}|${email}`;
    if (d.loginLimiter.blocked(key)) return fail(c, 429, 'rate_limited', 'Too many attempts. Try again later.');
    const user = email ? core.getUserByEmail(email) : undefined;
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || !user.password_hash || user.disabled) {
      d.loginLimiter.hit(key);
      core.audit({ actor: null, action: 'login_failed', targetId: user?.id, target: email.slice(0, 254) || null, ...meta(c), detail: user?.disabled ? { reason: 'disabled' } : null });
      return fail(c, 401, 'invalid_credentials', 'Invalid email or password.');
    }
    d.startSession(c, user);
    core.audit({ actor: user, action: 'login', targetId: user.id, target: user.email, ...meta(c) });
    return c.json({ redirect: d.safeReturnTo(b.returnTo) || '/account' });
  });

  api.post('/logout', (c) => {
    const cur = d.currentSession(c);
    d.endCurrentSession(c);
    if (cur) core.audit({ actor: cur.user, action: 'logout', targetId: cur.user.id, target: cur.user.email, ...meta(c) });
    return c.json({ ok: true });
  });

  // ---------- setup links ----------
  const setupRow = (token: string) =>
    db.prepare(`SELECT u.* FROM setup_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.disabled = 0`).get(sha256hex(token), now()) as UserRow | undefined;
  const setupGone = (c: Context) => fail(c, 404, 'not_found', 'This setup link is invalid, used or expired. Ask an administrator for a new one.');

  api.get('/setup/:token', (c) => {
    if (!d.setupLimiter.allow(d.ip(c))) return fail(c, 429, 'rate_limited', 'Too many attempts. Try again later.');
    const u = setupRow(c.req.param('token'));
    return u ? c.json({ email: u.email, name: u.name }) : setupGone(c);
  });

  api.post('/setup/:token', async (c) => {
    if (!d.setupLimiter.allow(d.ip(c))) return fail(c, 429, 'rate_limited', 'Too many attempts. Try again later.');
    const token = c.req.param('token');
    if (!setupRow(token)) return setupGone(c);
    const password = vPassword((await readBody(c)).password);
    if (!password) return fail(c, 400, 'invalid_password', 'Password must be at least 10 characters.');
    const hash = await hashPassword(password);
    // Single use: atomic claim.
    const row = db.prepare('SELECT user_id FROM setup_tokens WHERE token_hash = ?').get(sha256hex(token)) as { user_id: string } | undefined;
    const claimed = db.prepare('UPDATE setup_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(now(), sha256hex(token), now()).changes === 1;
    const user = row && core.getActiveUser(row.user_id);
    if (!claimed || !user) return setupGone(c);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    d.startSession(c, user);
    core.audit({ actor: user, action: 'setup_completed', targetId: user.id, target: user.email, ...meta(c) });
    return c.json({ redirect: '/account' });
  });

  // ---------- me ----------
  api.get('/me', authed((c, { user }) => c.json({ user: core.userJson(user) })));

  api.patch('/me', authed(async (c, { user }) => {
    const name = vName((await readBody(c)).name);
    if (!name) return fail(c, 400, 'invalid_name', 'Enter a name (up to 100 characters).');
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
    core.audit({ actor: user, action: 'profile_updated', targetId: user.id, target: user.email, ...meta(c), detail: { name } });
    return c.json({ user: core.userJson(core.getUser(user.id)!) });
  }));

  api.post('/me/password', authed(async (c, { user, session }) => {
    const b = await readBody(c);
    const key = `${d.ip(c)}|${user.email}`;
    if (d.loginLimiter.blocked(key)) return fail(c, 429, 'rate_limited', 'Too many attempts. Try again later.');
    const ok = user.password_hash && await verifyPassword(typeof b.current === 'string' ? b.current : '', user.password_hash);
    if (!ok) { d.loginLimiter.hit(key); return fail(c, 400, 'invalid_current_password', 'Current password is incorrect.'); }
    const next = vPassword(b.next);
    if (!next) return fail(c, 400, 'invalid_password', 'Password must be at least 10 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
    core.endUserEverywhere(user.id, session.sid); // other devices are signed out
    core.audit({ actor: user, action: 'password_changed', targetId: user.id, target: user.email, ...meta(c) });
    return c.json({ ok: true });
  }));

  api.get('/me/apps', authed((c, { user }) => c.json({ apps: core.effectiveApps(user).map(core.appInfo) })));

  api.get('/me/sessions', authed((c, { user, session }) => c.json({ sessions: activeSessions(user.id).map((s) => sessionJson(s, session.sid)) })));

  api.delete('/me/sessions/:id', authed((c, { user, session }) => {
    const s = activeSessions(user.id).find((x) => x.sid === c.req.param('id'));
    if (!s) return fail(c, 404, 'not_found', 'Session not found.');
    if (s.sid === session.sid) d.endCurrentSession(c);
    else core.endSessions([{ sid: s.sid, user_id: user.id }]);
    core.audit({ actor: user, action: 'session_revoked', targetId: user.id, target: user.email, ...meta(c), detail: { current: s.sid === session.sid } });
    return c.json({ ok: true });
  }));

  api.post('/me/sessions/revoke-all', authed((c, { user }) => {
    core.endUserEverywhere(user.id);
    deleteCookie(c, 'kore_sid', { path: '/', secure: config.secureCookies, httpOnly: true, sameSite: 'Lax' });
    core.audit({ actor: user, action: 'signed_out_everywhere', targetId: user.id, target: user.email, ...meta(c) });
    return c.json({ ok: true });
  }));

  // ---------- admin ----------
  const target = (c: Context) => core.getUser(c.req.param('id') ?? '');
  const notFound = (c: Context) => fail(c, 404, 'not_found', 'User not found.');
  const isLastActiveAdmin = (u: UserRow) => u.role === 'admin' && !u.disabled && core.activeAdminCount() <= 1;
  const lastAdmin = (c: Context) => fail(c, 409, 'last_admin', 'This is the last active administrator. Add another admin first.');

  api.get('/admin/users', admin((c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const rows = (q
      ? db.prepare("SELECT * FROM users WHERE lower(email) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' ORDER BY created_at, email").all(...Array(2).fill(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`))
      : db.prepare('SELECT * FROM users ORDER BY created_at, email').all()) as unknown as UserRow[];
    return c.json({ users: rows.map(core.userJson) });
  }));

  api.post('/admin/users', admin(async (c, { user: actor }) => {
    const b = await readBody(c);
    const email = vEmail(b.email), name = vName(b.name);
    const role = b.role === undefined ? 'user' : vRole(b.role);
    const apps = b.apps === undefined ? [] : vApps(b.apps);
    if (!email) return fail(c, 400, 'invalid_email', 'Enter a valid email.');
    if (!name) return fail(c, 400, 'invalid_name', 'Enter a name (up to 100 characters).');
    if (!role) return fail(c, 400, 'invalid_role', 'role must be "admin" or "user".');
    if (!apps) return fail(c, 400, 'invalid_apps', `apps must be a list of: ${core.appKeys().join(', ')}.`);
    if (core.getUserByEmail(email)) return fail(c, 409, 'email_taken', 'A user with that email already exists.');
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,NULL,?,?)').run(id, email, name, role, now());
    core.setApps(id, apps);
    const setupUrl = core.createSetupLink(id);
    core.audit({ actor, action: 'user_created', targetId: id, target: email, ...meta(c), detail: { role, apps } });
    return c.json({ user: core.userJson(core.getUser(id)!), setupUrl }, 201);
  }));

  api.get('/admin/users/:id', admin((c, { session }) => {
    const u = target(c);
    if (!u) return notFound(c);
    return c.json({ user: core.userJson(u), sessions: activeSessions(u.id).map((s) => sessionJson(s, session.sid)) });
  }));

  api.patch('/admin/users/:id', admin(async (c, { user: actor }) => {
    const u = target(c);
    if (!u) return notFound(c);
    const b = await readBody(c);
    const changes: Record<string, unknown> = {};
    let email = u.email, name = u.name, role = u.role, disabled = !!u.disabled, apps: string[] | null = null;
    if (b.email !== undefined) {
      const e = vEmail(b.email);
      if (!e) return fail(c, 400, 'invalid_email', 'Enter a valid email.');
      if (e !== u.email && core.getUserByEmail(e)) return fail(c, 409, 'email_taken', 'A user with that email already exists.');
      if (e !== u.email) changes.email = { from: u.email, to: e };
      email = e;
    }
    if (b.name !== undefined) {
      const n = vName(b.name);
      if (!n) return fail(c, 400, 'invalid_name', 'Enter a name (up to 100 characters).');
      if (n !== u.name) changes.name = n;
      name = n;
    }
    if (b.role !== undefined) {
      const r = vRole(b.role);
      if (!r) return fail(c, 400, 'invalid_role', 'role must be "admin" or "user".');
      if (r !== u.role) changes.role = r;
      role = r;
    }
    if (b.disabled !== undefined) {
      if (typeof b.disabled !== 'boolean') return fail(c, 400, 'invalid_disabled', 'disabled must be a boolean.');
      if (b.disabled !== !!u.disabled) changes.disabled = b.disabled;
      disabled = b.disabled;
    }
    if (b.apps !== undefined) {
      apps = vApps(b.apps);
      if (!apps) return fail(c, 400, 'invalid_apps', `apps must be a list of: ${core.appKeys().join(', ')}.`);
      const before = core.grantedApps(u.id);
      if (apps.length !== before.length || apps.some((a) => !before.includes(a))) changes.apps = apps;
    }
    if (isLastActiveAdmin(u) && (role !== 'admin' || disabled)) return lastAdmin(c);

    db.prepare('UPDATE users SET email = ?, name = ?, role = ?, disabled = ? WHERE id = ?').run(email, name, role, disabled ? 1 : 0, u.id);
    if (apps) core.setApps(u.id, apps);
    if (disabled && !u.disabled) core.endUserEverywhere(u.id);
    const m = meta(c);
    if ('disabled' in changes) core.audit({ actor, action: disabled ? 'user_disabled' : 'user_enabled', targetId: u.id, target: email, ...m });
    const { disabled: _d, ...rest } = changes;
    if (Object.keys(rest).length) core.audit({ actor, action: 'user_updated', targetId: u.id, target: email, ...m, detail: rest });
    return c.json({ user: core.userJson(core.getUser(u.id)!) });
  }));

  api.delete('/admin/users/:id', admin((c, { user: actor }) => {
    const u = target(c);
    if (!u) return notFound(c);
    if (isLastActiveAdmin(u)) return lastAdmin(c);
    core.endUserEverywhere(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    core.audit({ actor, action: 'user_deleted', targetId: u.id, target: u.email, ...meta(c) });
    if (u.id === actor.id) deleteCookie(c, 'kore_sid', { path: '/', secure: config.secureCookies, httpOnly: true, sameSite: 'Lax' });
    return c.json({ ok: true });
  }));

  api.post('/admin/users/:id/reset', admin((c, { user: actor }) => {
    const u = target(c);
    if (!u) return notFound(c);
    db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(u.id);
    core.endUserEverywhere(u.id);
    const setupUrl = core.createSetupLink(u.id);
    core.audit({ actor, action: 'password_reset', targetId: u.id, target: u.email, ...meta(c) });
    return c.json({ setupUrl });
  }));

  api.post('/admin/users/:id/signout', admin((c, { user: actor }) => {
    const u = target(c);
    if (!u) return notFound(c);
    core.endUserEverywhere(u.id);
    core.audit({ actor, action: 'user_signed_out', targetId: u.id, target: u.email, ...meta(c) });
    return c.json({ ok: true });
  }));

  api.get('/admin/apps', admin((c) => {
    const apps = core.appKeys().map((a) => ({
      ...core.appInfo(a),
      userCount: (db.prepare(`SELECT count(*) AS n FROM users u WHERE u.disabled = 0 AND (u.role = 'admin'
        OR EXISTS (SELECT 1 FROM user_apps x WHERE x.user_id = u.id AND x.app = ?))`).get(a) as { n: number }).n,
      clients: core.clientsOfApp(a).map((cl) => ({
        id: cl.id, name: cl.name, app: cl.app, public: !cl.secretHash, redirectUris: cl.redirectUris,
        postLogoutRedirectUris: cl.postLogoutRedirectUris, homeUrl: cl.homeUrl ?? null, backchannelLogoutUri: cl.backchannelLogoutUri ?? null,
      })),
    }));
    return c.json({ apps });
  }));

  api.get('/admin/audit', admin((c) => {
    const cursor = Number(c.req.query('cursor') ?? 0);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
    const where: string[] = [], args: (string | number)[] = [];
    if (cursor > 0) { where.push('id < ?'); args.push(cursor); }
    const user = c.req.query('user');
    if (user) { where.push('(actor_id = ? OR target_id = ?)'); args.push(user, user); }
    const action = c.req.query('action');
    if (action) { where.push('action = ?'); args.push(action); }
    const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit) as {
      id: number; created_at: number; actor_id: string | null; actor_email: string | null; action: string; target_id: string | null;
      target: string | null; ip: string | null; user_agent: string | null; detail: string | null;
    }[];
    return c.json({
      entries: rows.map((r) => ({
        id: r.id, time: core.iso(r.created_at), actor: r.actor_id || r.actor_email ? { id: r.actor_id, email: r.actor_email } : null,
        action: r.action, target: r.target_id || r.target ? { id: r.target_id, label: r.target } : null,
        ip: r.ip, userAgent: r.user_agent, detail: r.detail ? JSON.parse(r.detail) : null,
      })),
      nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
    });
  }));

  api.all('*', (c) => fail(c, 404, 'not_found', 'Not found.'));
  app.route('/api', api);
}
