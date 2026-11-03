import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { SignJWT, jwtVerify, createLocalJWKSet } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Config, Client } from './config.ts';
import type { Db, UserRow } from './db.ts';
import type { Keys } from './keys.ts';
import { hashPassword, verifyPassword, DUMMY_HASH, randomToken, sha256hex, sha256b64url, safeEqual } from './crypto.ts';
import { loginPage, registerPage, messagePage, accountPage } from './views.ts';

const SESSION_TTL = 14 * 86400;
const CODE_TTL = 60;
const ACCESS_TTL = 600;
const REFRESH_TTL = 30 * 86400;
const SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);
const now = () => Math.floor(Date.now() / 1000);

class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowSec: number;
  constructor(max: number, windowSec: number) { this.max = max; this.windowSec = windowSec; }
  /** Returns true if the action is allowed (and records it). */
  allow(key: string): boolean {
    const t = now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowSec);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10000) this.hits.clear();
    return true;
  }
}

export function createApp(config: Config, db: Db, keys: Keys) {
  const app = new Hono();
  const loginLimiter = new RateLimiter(10, 900);
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

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (c.res.headers.get('content-type')?.includes('text/html')) {
      c.header('X-Frame-Options', 'DENY');
      c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' *; frame-ancestors 'none'");
    }
    if (!c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-store');
  });

  const csrfToken = (c: Context) => {
    let t = getCookie(c, 'kore_csrf');
    if (!t) { t = randomToken(24); setCookie(c, 'kore_csrf', t, cookieOpts); }
    return t;
  };
  const csrfOk = (c: Context, body: Record<string, unknown>) => {
    const cookie = getCookie(c, 'kore_csrf');
    const field = body.csrf;
    return !!cookie && typeof field === 'string' && safeEqual(cookie, field);
  };

  const getUserById = (id: string) => db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(id) as UserRow | undefined;

  const currentUser = (c: Context): UserRow | undefined => {
    const sid = getCookie(c, 'kore_sid');
    if (!sid) return;
    const s = db.prepare('SELECT user_id FROM sessions WHERE id_hash = ? AND expires_at > ?').get(sha256hex(sid), now()) as { user_id: string } | undefined;
    return s && getUserById(s.user_id);
  };

  const startSession = (c: Context, userId: string) => {
    const sid = randomToken(32);
    db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(sha256hex(sid), userId, now() + SESSION_TTL, now());
    setCookie(c, 'kore_sid', sid, { ...cookieOpts, maxAge: SESSION_TTL });
  };

  /** return_to must be a local /authorize URL; anything else is dropped (no open redirect). */
  const safeReturnTo = (v: unknown) => (typeof v === 'string' && /^\/authorize\?[^\s]*$/.test(v) ? v : '');

  const appNameFor = (returnTo: string) => {
    try { return config.clients.get(new URL(returnTo, config.issuer).searchParams.get('client_id') ?? '')?.name; } catch { return undefined; }
  };

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
      end_session_endpoint: `${config.issuer}/logout`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['EdDSA'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      scopes_supported: [...SCOPES],
      claims_supported: ['sub', 'email', 'name', 'iss', 'aud', 'exp', 'iat', 'nonce'],
    }),
  );
  app.get('/.well-known/jwks.json', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(keys.jwks);
  });

  // ---------- login / register ----------
  app.get('/', (c) => c.redirect('/account'));

  app.get('/login', (c) => {
    const returnTo = safeReturnTo(c.req.query('return_to'));
    if (currentUser(c) && returnTo) return c.redirect(returnTo);
    if (currentUser(c)) return c.redirect('/account');
    return c.html(loginPage({ csrf: csrfToken(c), returnTo, app: appNameFor(returnTo), allowRegistration: config.allowRegistration }));
  });

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const returnTo = safeReturnTo(body.return_to);
    const email = String(body.email ?? '').trim().toLowerCase();
    const render = (error: string, status: 400 | 403 | 429 = 400) =>
      c.html(loginPage({ csrf: csrfToken(c), returnTo, email, error, app: appNameFor(returnTo), allowRegistration: config.allowRegistration }), status);

    if (!csrfOk(c, body)) return render('Session expired. Please try again.', 403);
    if (!loginLimiter.allow(`${ip(c)}|${email}`)) return render('Too many attempts. Try again later.', 429);

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    const ok = await verifyPassword(String(body.password ?? ''), user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled) return render('Invalid email or password.');

    startSession(c, user.id);
    return c.redirect(returnTo || '/account');
  });

  app.get('/register', (c) => {
    if (!config.allowRegistration) return c.html(messagePage('Closed', 'Registration is disabled.'), 403);
    const returnTo = safeReturnTo(c.req.query('return_to'));
    return c.html(registerPage({ csrf: csrfToken(c), returnTo, app: appNameFor(returnTo) }));
  });

  app.post('/register', async (c) => {
    if (!config.allowRegistration) return c.html(messagePage('Closed', 'Registration is disabled.'), 403);
    const body = await c.req.parseBody();
    const returnTo = safeReturnTo(body.return_to);
    const email = String(body.email ?? '').trim().toLowerCase();
    const name = String(body.name ?? '').trim();
    const password = String(body.password ?? '');
    const render = (error: string, status: 400 | 403 | 429 = 400) => c.html(registerPage({ csrf: csrfToken(c), returnTo, email, name, error }), status);

    if (!csrfOk(c, body)) return render('Session expired. Please try again.', 403);
    if (!loginLimiter.allow(`reg|${ip(c)}`)) return render('Too many attempts. Try again later.', 429);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return render('Enter a valid email.');
    if (!name || name.length > 100) return render('Enter your name.');
    if (password.length < 10 || password.length > 1024) return render('Password must be at least 10 characters.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return render('That email is already registered.');

    const id = randomUUID();
    db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)').run(id, email, name, await hashPassword(password), now());
    startSession(c, id);
    return c.redirect(returnTo || '/account');
  });

  app.get('/account', (c) => {
    const user = currentUser(c);
    if (!user) return c.redirect('/login');
    return c.html(accountPage(user, csrfToken(c)));
  });

  // ---------- logout ----------
  const endSession = (c: Context, revokeTokens: boolean) => {
    const sid = getCookie(c, 'kore_sid');
    if (sid) {
      const row = db.prepare('SELECT user_id FROM sessions WHERE id_hash = ?').get(sha256hex(sid)) as { user_id: string } | undefined;
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256hex(sid));
      if (row && revokeTokens) db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(row.user_id);
    }
    deleteCookie(c, 'kore_sid', cookieOpts);
  };

  // POST: account-page button, signs the user out of every app (revokes all refresh tokens)
  app.post('/logout', async (c) => {
    const body = await c.req.parseBody();
    if (!csrfOk(c, body)) return c.html(messagePage('Error', 'Invalid request.'), 403);
    endSession(c, true);
    return c.redirect('/login');
  });

  // GET: OIDC RP-initiated logout. Ends the SSO session; apps clear their own sessions on redirect.
  app.get('/logout', async (c) => {
    let target: string | undefined;
    const redirect = c.req.query('post_logout_redirect_uri');
    const hint = c.req.query('id_token_hint');
    if (redirect && hint) {
      try {
        const { payload } = await jwtVerify(hint, localJwks, { issuer: config.issuer, clockTolerance: 365 * 86400 });
        const client = config.clients.get(String(payload.aud));
        if (client?.postLogoutRedirectUris.includes(redirect)) target = redirectWith(redirect, { state: c.req.query('state') });
      } catch { /* invalid hint: ignore redirect */ }
    }
    endSession(c, false);
    return target ? c.redirect(target) : c.html(messagePage('Signed out', 'You have been signed out of Kore ID.'));
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
    const user = prompts.includes('login') ? undefined : currentUser(c);
    if (!user) {
      if (prompts.includes('none')) return fail('login_required', 'No active session.');
      const params = new URLSearchParams(q);
      params.delete('prompt');
      return c.redirect(`/login?return_to=${encodeURIComponent(`/authorize?${params}`)}`);
    }

    // First-party clients: no consent screen.
    const code = randomToken(32);
    db.prepare('INSERT INTO auth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, nonce, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sha256hex(code), client.id, user.id, q.redirect_uri, q.code_challenge, scopes.join(' '), q.nonce ?? null, now() + CODE_TTL);
    return c.redirect(redirectWith(q.redirect_uri, { code, state: q.state, iss: config.issuer }));
  });

  // ---------- token ----------
  const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) => {
    if (status === 401) c.header('WWW-Authenticate', 'Basic realm="kore-id"');
    return c.json({ error, error_description: description }, status);
  };

  const authenticateClient = (c: Context, body: Record<string, unknown>): Client | null => {
    let id = typeof body.client_id === 'string' ? body.client_id : '';
    let secret = typeof body.client_secret === 'string' ? body.client_secret : '';
    const basic = c.req.header('authorization');
    if (basic?.startsWith('Basic ')) {
      const [u, ...rest] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
      id = decodeURIComponent(u ?? '');
      secret = decodeURIComponent(rest.join(':'));
    }
    const client = config.clients.get(id);
    if (!client) return null;
    if (client.secretHash && !safeEqual(sha256hex(secret), client.secretHash)) return null;
    return client;
  };

  async function issueTokens(user: UserRow, client: Client, scope: string, nonce: string | null, family?: string) {
    const scopes = scope.split(' ');
    const iat = now();
    const base = { iss: config.issuer, aud: client.id, sub: user.id };
    const sign = (claims: Record<string, unknown>, ttl: number) =>
      new SignJWT({ ...claims, ...base }).setProtectedHeader({ alg: 'EdDSA', kid: keys.kid }).setIssuedAt(iat).setExpirationTime(iat + ttl).setJti(randomUUID()).sign(keys.signKey);

    const access = await sign({ scope, ...(scopes.includes('email') && { email: user.email }) }, ACCESS_TTL);
    const idClaims: Record<string, unknown> = { ...(nonce && { nonce }) };
    if (scopes.includes('email')) { idClaims.email = user.email; }
    if (scopes.includes('profile')) { idClaims.name = user.name; }
    const idToken = await sign(idClaims, ACCESS_TTL);

    const out: Record<string, unknown> = { token_type: 'Bearer', access_token: access, id_token: idToken, expires_in: ACCESS_TTL, scope };
    if (scopes.includes('offline_access')) {
      const refresh = randomToken(32);
      db.prepare('INSERT INTO refresh_tokens (token_hash, family, user_id, client_id, scope, expires_at) VALUES (?,?,?,?,?,?)')
        .run(sha256hex(refresh), family ?? randomUUID(), user.id, client.id, scope, iat + REFRESH_TTL);
      out.refresh_token = refresh;
    }
    return out;
  }

  app.post('/token', async (c) => {
    if (!tokenLimiter.allow(ip(c))) return oauthError(c, 'invalid_request', 'Rate limited.');
    const body = await c.req.parseBody();
    const client = authenticateClient(c, body);
    if (!client) return oauthError(c, 'invalid_client', 'Client authentication failed.', 401);

    if (body.grant_type === 'authorization_code') {
      const code = String(body.code ?? '');
      const row = db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(sha256hex(code)) as
        | { client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string; nonce: string | null; expires_at: number }
        | undefined;
      // Single use: atomic claim. Whoever flips used=1 wins.
      const claimed = row && db.prepare('UPDATE auth_codes SET used = 1 WHERE code_hash = ? AND used = 0').run(sha256hex(code)).changes === 1;
      if (!row || !claimed || row.expires_at < now() || row.client_id !== client.id || row.redirect_uri !== body.redirect_uri)
        return oauthError(c, 'invalid_grant', 'Invalid or expired code.');
      const verifier = String(body.code_verifier ?? '');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(sha256b64url(verifier), row.code_challenge))
        return oauthError(c, 'invalid_grant', 'PKCE verification failed.');
      const user = getUserById(row.user_id);
      if (!user) return oauthError(c, 'invalid_grant', 'User unavailable.');
      return c.json(await issueTokens(user, client, row.scope, row.nonce));
    }

    if (body.grant_type === 'refresh_token') {
      const hash = sha256hex(String(body.refresh_token ?? ''));
      const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash) as
        | { family: string; user_id: string; client_id: string; scope: string; expires_at: number; revoked: number }
        | undefined;
      if (!row || row.client_id !== client.id) return oauthError(c, 'invalid_grant', 'Invalid refresh token.');
      if (row.revoked) {
        // Reuse of a rotated token => assume theft, kill the whole family.
        db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE family = ?').run(row.family);
        return oauthError(c, 'invalid_grant', 'Refresh token reuse detected.');
      }
      if (row.expires_at < now()) return oauthError(c, 'invalid_grant', 'Refresh token expired.');
      const claimed = db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0').run(hash).changes === 1;
      const user = getUserById(row.user_id);
      if (!claimed || !user) return oauthError(c, 'invalid_grant', 'Invalid refresh token.');
      return c.json(await issueTokens(user, client, row.scope, null, row.family));
    }

    return oauthError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  app.post('/revoke', async (c) => {
    const body = await c.req.parseBody();
    const client = authenticateClient(c, body);
    if (!client) return oauthError(c, 'invalid_client', 'Client authentication failed.', 401);
    const hash = sha256hex(String(body.token ?? ''));
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?').run(hash, client.id);
    return c.body(null, 200); // RFC 7009: always 200
  });

  app.get('/userinfo', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const unauthorized = () => { c.header('WWW-Authenticate', 'Bearer error="invalid_token"'); return c.json({ error: 'invalid_token' }, 401); };
    if (!auth.startsWith('Bearer ')) return unauthorized();
    try {
      const { payload } = await jwtVerify(auth.slice(7), localJwks, { issuer: config.issuer, algorithms: ['EdDSA'] });
      const user = getUserById(String(payload.sub));
      if (!user) return unauthorized();
      const scopes = String(payload.scope ?? '').split(' ');
      return c.json({
        sub: user.id,
        ...(scopes.includes('profile') && { name: user.name }),
        ...(scopes.includes('email') && { email: user.email }),
      });
    } catch { return unauthorized(); }
  });

  return app;
}
