import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { SignJWT, jwtVerify, createLocalJWKSet, type JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import type { Config, Client } from './config.ts';
import type { Db, UserRow, SessionRow } from './db.ts';
import type { Keys } from './keys.ts';
import { randomToken, sha256hex, sha256b64url, safeEqual } from './crypto.ts';
import { createCore, now, type AppOptions } from './core.ts';
import { registerApi } from './api.ts';
import { messagePage, noAccessPage, logoutConfirmPage, signedOutPage, webNotBuiltPage } from './views.ts';

const SESSION_TTL = 14 * 86400;
const CODE_TTL = 60;
const ACCESS_TTL = 600;
const REFRESH_TTL = 30 * 86400;
const SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowSec: number;
  constructor(max: number, windowSec: number) { this.max = max; this.windowSec = windowSec; }
  private recent(key: string) { const t = now(); return (this.hits.get(key) ?? []).filter((x) => x > t - this.windowSec); }
  /** True if the key is currently over the limit (does not record). */
  blocked(key: string) { return this.recent(key).length >= this.max; }
  /** Record one hit. */
  hit(key: string) {
    const r = this.recent(key); r.push(now()); this.hits.set(key, r);
    if (this.hits.size > 10000) this.hits.clear();
  }
  /** Returns true if the action is allowed (and records it). */
  allow(key: string): boolean { if (this.blocked(key)) return false; this.hit(key); return true; }
}

export interface CurrentSession { session: SessionRow; user: UserRow }

export function createApp(config: Config, db: Db, keys: Keys, opts: AppOptions = {}) {
  const app = new Hono();
  const core = createCore(config, db, keys, opts);
  const loginLimiter = new RateLimiter(10, 900);
  const setupLimiter = new RateLimiter(30, 900);
  const tokenLimiter = new RateLimiter(120, 60);
  const localJwks = createLocalJWKSet(keys.jwks);
  const cookieOpts = { httpOnly: true, sameSite: 'Lax' as const, secure: config.secureCookies, path: '/' };

  // ---------- helpers ----------
  const ip = (c: Context) => {
    if (config.trustProxy) {
      const x = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (x) return x;
    }
    try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
  };
  const ua = (c: Context) => c.req.header('user-agent')?.slice(0, 300) ?? null;

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (c.res.headers.get('content-type')?.includes('text/html')) {
      c.header('X-Frame-Options', 'DENY');
      if (!c.res.headers.has('content-security-policy'))
        c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' *; frame-ancestors 'none'");
    }
    if (!c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-store');
  });

  const csrfToken = (c: Context) => {
    let t = getCookie(c, 'kore_csrf');
    if (!t) { t = randomToken(24); setCookie(c, 'kore_csrf', t, cookieOpts); }
    return t;
  };
  const csrfOk = (c: Context, value: unknown) => {
    const cookie = getCookie(c, 'kore_csrf');
    return !!cookie && typeof value === 'string' && safeEqual(cookie, value);
  };

  const sessionByCookie = (c: Context) => {
    const cookie = getCookie(c, 'kore_sid');
    if (!cookie) return;
    return db.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ? AND ended_at IS NULL').get(sha256hex(cookie), now()) as SessionRow | undefined;
  };

  const currentSession = (c: Context): CurrentSession | undefined => {
    const session = sessionByCookie(c);
    if (!session) return;
    const user = core.getActiveUser(session.user_id);
    if (!user) return;
    if (!session.last_seen_at || now() - session.last_seen_at > 60) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE sid = ?').run(now(), session.sid);
    return { session, user };
  };

  const endCurrentSession = (c: Context) => {
    const s = sessionByCookie(c);
    if (s) core.endSessions([{ sid: s.sid, user_id: s.user_id }]);
    deleteCookie(c, 'kore_sid', cookieOpts);
    return s;
  };

  /** Sign `user` in on this browser. Same user already signed in: keep the session (and its sid), bump auth_time.
   * Different user: end that session first (fires back-channel logout). */
  const startSession = (c: Context, user: UserRow) => {
    const t = now();
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(t, user.id);
    const existing = sessionByCookie(c);
    if (existing?.user_id === user.id) {
      db.prepare('UPDATE sessions SET auth_time = ?, last_seen_at = ? WHERE sid = ?').run(t, t, existing.sid);
      return existing.sid;
    }
    if (existing) endCurrentSession(c);
    const cookie = randomToken(32);
    const sid = randomToken(16);
    db.prepare('INSERT INTO sessions (id_hash, sid, user_id, expires_at, created_at, auth_time, last_seen_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(sha256hex(cookie), sid, user.id, t + SESSION_TTL, t, t, t, ip(c), ua(c));
    setCookie(c, 'kore_sid', cookie, { ...cookieOpts, maxAge: SESSION_TTL });
    return sid;
  };

  /** return_to must be a local /authorize URL; anything else is dropped (no open redirect). */
  const safeReturnTo = (v: unknown) => (typeof v === 'string' && /^\/authorize\?[^\s\\]*$/.test(v) ? v : '');

  const redirectWith = (base: string, params: Record<string, string | undefined>) => {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };

  // ---------- discovery ----------
  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      userinfo_endpoint: `${config.issuer}/userinfo`,
      jwks_uri: `${config.issuer}/.well-known/jwks.json`,
      revocation_endpoint: `${config.issuer}/revoke`,
      introspection_endpoint: `${config.issuer}/introspect`,
      end_session_endpoint: `${config.issuer}/logout`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['EdDSA'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      scopes_supported: [...SCOPES],
      claims_supported: ['sub', 'iss', 'aud', 'azp', 'exp', 'iat', 'auth_time', 'sid', 'nonce', 'email', 'email_verified', 'name'],
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
    }),
  );
  app.get('/.well-known/jwks.json', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(keys.jwks);
  });

  // ---------- JSON API for the web UI ----------
  registerApi(app, { config, db, core, ip, ua, csrfToken, currentSession, startSession, endCurrentSession, safeReturnTo, loginLimiter, setupLimiter });

  // ---------- logout ----------
  const verifyIdTokenHint = async (hint: string | undefined) => {
    if (!hint) return;
    try {
      const { payload } = await jwtVerify(hint, localJwks, { issuer: config.issuer, typ: 'JWT', algorithms: ['EdDSA'], clockTolerance: 86400 });
      const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
      const client = config.clients.get(String(aud ?? ''));
      return client && payload.sub ? { payload, client } : undefined;
    } catch { return; }
  };
  const logoutTarget = (client: Client | undefined, redirect: unknown, state: unknown) =>
    client && typeof redirect === 'string' && client.postLogoutRedirectUris.includes(redirect)
      ? redirectWith(redirect, { state: typeof state === 'string' && state ? state : undefined })
      : undefined;

  // GET: OIDC RP-initiated logout. Valid id_token_hint => end the session now; otherwise ask (no silent cross-site logout).
  app.get('/logout', async (c) => {
    const q = c.req.query();
    const hint = await verifyIdTokenHint(q.id_token_hint);
    const cur = currentSession(c);
    if (hint && (!cur || cur.user.id === hint.payload.sub)) {
      if (cur) {
        endCurrentSession(c);
        core.audit({ actor: cur.user, action: 'logout', targetId: cur.user.id, target: cur.user.email, ip: ip(c), userAgent: ua(c), detail: { client: hint.client.id } });
      }
      const target = logoutTarget(hint.client, q.post_logout_redirect_uri, q.state);
      return target ? c.redirect(target) : c.html(signedOutPage());
    }
    const client = config.clients.get(q.client_id ?? '') ?? hint?.client;
    const target = logoutTarget(client, q.post_logout_redirect_uri, q.state);
    if (!cur) return target ? c.redirect(target) : c.html(signedOutPage());
    return c.html(logoutConfirmPage({
      csrf: csrfToken(c), redirect: target ? q.post_logout_redirect_uri : undefined, clientId: target ? client!.id : undefined, state: q.state,
    }));
  });

  // POST: the confirm page's form.
  app.post('/logout', async (c) => {
    const body = await c.req.parseBody();
    if (!csrfOk(c, body.csrf)) return c.html(messagePage('Error', 'Invalid request. Go back and try again.'), 403);
    const cur = currentSession(c);
    endCurrentSession(c);
    if (cur) core.audit({ actor: cur.user, action: 'logout', targetId: cur.user.id, target: cur.user.email, ip: ip(c), userAgent: ua(c) });
    const target = logoutTarget(config.clients.get(String(body.client_id ?? '')), body.post_logout_redirect_uri, body.state);
    return target ? c.redirect(target, 302) : c.html(signedOutPage());
  });

  // ---------- authorize ----------
  app.get('/authorize', (c) => {
    const q = c.req.query();
    const client = config.clients.get(q.client_id ?? '');
    // Errors before redirect_uri is trusted must NOT redirect.
    if (!client) return c.html(messagePage('Error', 'Unknown client.'), 400);
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) return c.html(messagePage('Error', 'redirect_uri is not registered for this client.'), 400);

    const fail = (error: string, description: string) =>
      c.redirect(redirectWith(q.redirect_uri!, { error, error_description: description, state: q.state, iss: config.issuer }));

    if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge))
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    const scopes = (q.scope ?? '').split(' ').filter(Boolean);
    if (!scopes.includes('openid') || scopes.some((s) => !SCOPES.has(s))) return fail('invalid_scope', 'scope must include openid and only known scopes.');

    const prompts = (q.prompt ?? '').split(' ');
    const params = new URLSearchParams(q);
    params.delete('prompt');
    const loginUrl = (forceLogin: boolean) => `/login?return_to=${encodeURIComponent(`/authorize?${params}`)}${forceLogin ? '&prompt=login' : ''}`;
    const cur = prompts.includes('login') ? undefined : currentSession(c);
    if (!cur) {
      if (prompts.includes('none')) return fail('login_required', 'No active session.');
      return c.redirect(loginUrl(prompts.includes('login')));
    }
    const { user, session } = cur;

    if (!core.hasAccess(user, client)) {
      core.audit({ actor: user, action: 'app_access_denied', targetId: user.id, target: user.email, ip: ip(c), userAgent: ua(c), detail: { client: client.id, app: client.app } });
      if (prompts.includes('none')) return fail('access_denied', 'This account has no access to this app.');
      return c.html(noAccessPage(core.appInfo(client.app).name, loginUrl(true)), 403);
    }

    // First-party clients: no consent screen.
    const code = randomToken(32);
    db.prepare('INSERT INTO auth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, nonce, expires_at, sid, auth_time) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(sha256hex(code), client.id, user.id, q.redirect_uri, q.code_challenge, scopes.join(' '), q.nonce ?? null, now() + CODE_TTL, session.sid, session.auth_time);
    return c.redirect(redirectWith(q.redirect_uri, { code, state: q.state, iss: config.issuer }));
  });

  // ---------- token ----------
  const oauthError = (c: Context, error: string, description: string, status: 400 | 401 | 429 = 400) => {
    if (status === 401) c.header('WWW-Authenticate', 'Basic realm="kore-id"');
    return c.json({ error, error_description: description }, status);
  };

  /** Client authentication (Basic or POST body). Any malformed Authorization header => null (401), never a throw. */
  const authenticateClient = (c: Context, body: Record<string, unknown>): Client | null => {
    let id = typeof body.client_id === 'string' ? body.client_id : '';
    let secret = typeof body.client_secret === 'string' ? body.client_secret : '';
    const header = c.req.header('authorization');
    if (header !== undefined) {
      const m = /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
      if (!m) return null;
      const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i < 1) return null;
      try {
        const basicId = decodeURIComponent(decoded.slice(0, i).replace(/\+/g, ' '));
        const basicSecret = decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, ' '));
        if (id && id !== basicId) return null;
        id = basicId; secret = basicSecret;
      } catch { return null; }
    }
    const client = config.clients.get(id);
    if (!client) return null;
    if (client.secretHash && !safeEqual(sha256hex(secret), client.secretHash)) return null;
    return client;
  };

  async function issueTokens(user: UserRow, client: Client, scope: string, nonce: string | null, sid: string | null, authTime: number | null, family?: string) {
    const scopes = scope.split(' ');
    const iat = now();
    const email = scopes.includes('email');
    const signer = (claims: Record<string, unknown>, typ: string) =>
      new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid: keys.kid, typ })
        .setIssuer(config.issuer).setSubject(user.id).setAudience(client.id).setIssuedAt(iat).setExpirationTime(iat + ACCESS_TTL);

    const access = await signer({
      client_id: client.id, scope, ...(sid && { sid }),
      ...(email && { email: user.email, email_verified: true }),
    }, 'at+jwt').setJti(randomUUID()).sign(keys.signKey);

    const idToken = await signer({
      azp: client.id, ...(authTime && { auth_time: authTime }), ...(sid && { sid }), ...(nonce && { nonce }),
      ...(email && { email: user.email, email_verified: true }),
      ...(scopes.includes('profile') && { name: user.name }),
    }, 'JWT').sign(keys.signKey);

    if (sid) db.prepare('INSERT OR IGNORE INTO session_clients (sid, client_id, created_at) VALUES (?,?,?)').run(sid, client.id, iat);

    const out: Record<string, unknown> = { token_type: 'Bearer', access_token: access, id_token: idToken, expires_in: ACCESS_TTL, scope };
    if (scopes.includes('offline_access')) {
      const refresh = randomToken(32);
      db.prepare('INSERT INTO refresh_tokens (token_hash, family, user_id, client_id, scope, expires_at, sid, auth_time) VALUES (?,?,?,?,?,?,?,?)')
        .run(sha256hex(refresh), family ?? randomUUID(), user.id, client.id, scope, iat + REFRESH_TTL, sid, authTime);
      out.refresh_token = refresh;
    }
    return out;
  }

  app.post('/token', async (c) => {
    if (!tokenLimiter.allow(ip(c))) return oauthError(c, 'invalid_request', 'Rate limited.', 429);
    const body = await c.req.parseBody();
    const client = authenticateClient(c, body);
    if (!client) return oauthError(c, 'invalid_client', 'Client authentication failed.', 401);

    if (body.grant_type === 'authorization_code') {
      const code = String(body.code ?? '');
      const row = db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(sha256hex(code)) as
        | { client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string; nonce: string | null; expires_at: number; sid: string | null; auth_time: number | null }
        | undefined;
      // Single use: atomic claim. Whoever flips used=1 wins.
      const claimed = row && db.prepare('UPDATE auth_codes SET used = 1 WHERE code_hash = ? AND used = 0').run(sha256hex(code)).changes === 1;
      if (!row || !claimed || row.expires_at < now() || row.client_id !== client.id || row.redirect_uri !== body.redirect_uri)
        return oauthError(c, 'invalid_grant', 'Invalid or expired code.');
      const verifier = String(body.code_verifier ?? '');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(sha256b64url(verifier), row.code_challenge))
        return oauthError(c, 'invalid_grant', 'PKCE verification failed.');
      const user = core.getActiveUser(row.user_id);
      if (!user || !core.hasAccess(user, client)) return oauthError(c, 'invalid_grant', 'User unavailable.');
      if (row.sid && core.sessionEnded(row.sid)) return oauthError(c, 'invalid_grant', 'Session ended.');
      return c.json(await issueTokens(user, client, row.scope, row.nonce, row.sid, row.auth_time));
    }

    if (body.grant_type === 'refresh_token') {
      const hash = sha256hex(String(body.refresh_token ?? ''));
      const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash) as
        | { family: string; user_id: string; client_id: string; scope: string; expires_at: number; revoked: number; sid: string | null; auth_time: number | null }
        | undefined;
      if (!row || row.client_id !== client.id) return oauthError(c, 'invalid_grant', 'Invalid refresh token.');
      if (row.revoked) {
        // Reuse of a rotated token => assume theft, kill the whole family.
        db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE family = ?').run(row.family);
        return oauthError(c, 'invalid_grant', 'Refresh token reuse detected.');
      }
      if (row.expires_at < now()) return oauthError(c, 'invalid_grant', 'Refresh token expired.');
      const claimed = db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0').run(hash).changes === 1;
      const user = core.getActiveUser(row.user_id);
      if (!claimed || !user || !core.hasAccess(user, client)) return oauthError(c, 'invalid_grant', 'Invalid refresh token.');
      return c.json(await issueTokens(user, client, row.scope, null, row.sid, row.auth_time, row.family));
    }

    return oauthError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  /** Verify one of our access tokens (signature, issuer, expiry, typ at+jwt). */
  const verifyAccessToken = async (token: string): Promise<JWTPayload | undefined> => {
    try {
      const { payload } = await jwtVerify(token, localJwks, { issuer: config.issuer, typ: 'at+jwt', algorithms: ['EdDSA'] });
      return payload;
    } catch { return; }
  };
  /** Active = valid, not revoked, user active and still allowed to use the app, session not ended. */
  const accessTokenActive = (p: JWTPayload) => {
    if (!p.jti || db.prepare('SELECT 1 FROM revoked_jti WHERE jti = ?').get(p.jti)) return undefined;
    const user = core.getActiveUser(String(p.sub));
    const client = config.clients.get(String(p.client_id ?? ''));
    if (!user || !client || !core.hasAccess(user, client)) return undefined;
    if (typeof p.sid === 'string' && core.sessionEnded(p.sid)) return undefined;
    return user;
  };
  const looksLikeJwt = (t: string) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(t);

  app.post('/revoke', async (c) => {
    const body = await c.req.parseBody();
    const client = authenticateClient(c, body);
    if (!client) return oauthError(c, 'invalid_client', 'Client authentication failed.', 401);
    const token = String(body.token ?? '');
    if (looksLikeJwt(token)) {
      const p = await verifyAccessToken(token);
      if (p?.jti && p.client_id === client.id)
        db.prepare('INSERT OR IGNORE INTO revoked_jti (jti, expires_at) VALUES (?, ?)').run(p.jti, Number(p.exp));
    } else {
      db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?').run(sha256hex(token), client.id);
    }
    return c.body(null, 200); // RFC 7009: always 200
  });

  // RFC 7662. A client may only introspect its own tokens.
  app.post('/introspect', async (c) => {
    if (!tokenLimiter.allow(ip(c))) return oauthError(c, 'invalid_request', 'Rate limited.', 429);
    const body = await c.req.parseBody();
    const client = authenticateClient(c, body);
    if (!client) return oauthError(c, 'invalid_client', 'Client authentication failed.', 401);
    const token = String(body.token ?? '');
    const inactive = () => c.json({ active: false });
    if (looksLikeJwt(token)) {
      const p = await verifyAccessToken(token);
      if (!p || p.client_id !== client.id || !accessTokenActive(p)) return inactive();
      return c.json({ active: true, sub: p.sub, client_id: p.client_id, scope: p.scope, exp: p.exp, iat: p.iat, sid: p.sid, token_type: 'access_token', iss: p.iss, aud: p.aud });
    }
    const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(sha256hex(token)) as
      | { user_id: string; client_id: string; scope: string; expires_at: number; revoked: number; sid: string | null }
      | undefined;
    if (!row || row.client_id !== client.id || row.revoked || row.expires_at < now() || !core.getActiveUser(row.user_id) || (row.sid && core.sessionEnded(row.sid)))
      return inactive();
    return c.json({ active: true, sub: row.user_id, client_id: row.client_id, scope: row.scope, exp: row.expires_at, sid: row.sid ?? undefined, token_type: 'refresh_token', iss: config.issuer });
  });

  app.get('/userinfo', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const unauthorized = () => { c.header('WWW-Authenticate', 'Bearer error="invalid_token"'); return c.json({ error: 'invalid_token' }, 401); };
    if (!auth.startsWith('Bearer ')) return unauthorized();
    const p = await verifyAccessToken(auth.slice(7));
    const user = p && accessTokenActive(p);
    if (!p || !user) return unauthorized();
    const scopes = String(p.scope ?? '').split(' ');
    return c.json({
      sub: user.id,
      ...(scopes.includes('profile') && { name: user.name }),
      ...(scopes.includes('email') && { email: user.email, email_verified: true }),
    });
  });

  // ---------- SPA (web/dist) ----------
  const indexFile = join(config.webDir, 'index.html');
  const assetsDir = resolve(config.webDir, 'assets');
  const TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.map': 'application/json',
    '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  };
  const SPA_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  const sendFile = (c: Context, file: string, cache: string) => {
    try { if (!statSync(file).isFile()) return c.notFound(); } catch { return c.notFound(); }
    return c.body(readFileSync(file), 200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache });
  };
  const spa = (c: Context) => {
    if (!existsSync(indexFile)) return c.html(webNotBuiltPage(), 503);
    c.header('Content-Security-Policy', SPA_CSP);
    c.header('Cache-Control', 'no-cache');
    return c.html(readFileSync(indexFile, 'utf8'));
  };
  app.get('/', (c) => c.redirect('/account'));
  for (const p of ['/login', '/setup/:token', '/account', '/account/*', '/admin', '/admin/*']) app.get(p, spa);
  app.get('/assets/*', (c) => {
    let file: string;
    try { file = resolve(assetsDir, decodeURIComponent(c.req.path.slice('/assets/'.length))); } catch { return c.notFound(); }
    if (!file.startsWith(assetsDir + sep)) return c.notFound();
    return sendFile(c, file, 'public, max-age=31536000, immutable');
  });
  // Root-level files Vite copies from public/ (favicon etc.).
  app.get('/:file{[A-Za-z0-9._-]+\\.(svg|png|ico|webmanifest|txt)}', (c) => sendFile(c, join(config.webDir, c.req.param('file')), 'public, max-age=3600'));

  return Object.assign(app, { core, idle: core.idle });
}
