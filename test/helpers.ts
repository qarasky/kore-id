import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { loadKeys } from '../src/keys.ts';
import { bootstrapAdmin } from '../src/core.ts';
import type { Config, Client } from '../src/config.ts';

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const ISS = 'http://auth.test';
export const ADMIN = 'sky@qarasky.dev';
export const PW = 'correct horse battery';
export const names = ['kore', 'koremind', 'korecalendar', 'flatline'];

export function makeConfig(over: Partial<Config> = {}): Config {
  const clients = new Map(names.map((id) => [id, {
    id, name: id[0]!.toUpperCase() + id.slice(1), app: id, secretHash: sha(`secret-${id}`),
    redirectUris: [`http://${id}.test/cb`], postLogoutRedirectUris: [`http://${id}.test/`],
    backchannelLogoutUri: `http://${id}.test/backchannel-logout`, homeUrl: `http://${id}.test/`,
  } as Client]));
  clients.set('korecalendar-android', {
    id: 'korecalendar-android', name: 'KoreCalendar (Android)', app: 'korecalendar',
    redirectUris: ['dev.qarasky.korecalendar:/oauth2redirect'], postLogoutRedirectUris: [],
  });
  return {
    issuer: ISS, port: 0, dataDir: ':memory:', secureCookies: false, trustProxy: false, adminEmail: ADMIN,
    webDir: '/nonexistent/web/dist', clients, ...over,
  };
}

export const keys = await loadKeys(':memory:');

export interface Sent { url: string; token: string }

export function makeEnv(over: Partial<Config> = {}) {
  const config = makeConfig(over);
  const db = openDb(':memory:');
  const sent: Sent[] = [];
  const ctl = { failNext: 0 };
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), token: new URLSearchParams(String(init?.body ?? '')).get('logout_token') ?? '' });
    if (ctl.failNext > 0) { ctl.failNext--; return new Response('nope', { status: 500 }); }
    return new Response('ok');
  }) as typeof fetch;
  const logs: string[] = [];
  const app = createApp(config, db, keys, { fetch: fetchStub, backchannelRetryDelayMs: 1, log: (m) => logs.push(m) });
  const adminLink = bootstrapAdmin(config, db, app.core)!;

  /** Minimal cookie jar = the user's browser. */
  class Browser {
    jar = new Map<string, string>();
    async req(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (this.jar.size) headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await app.request(ISS + path, { ...init, headers, redirect: 'manual' });
      for (const sc of res.headers.getSetCookie()) {
        const [kv] = sc.split(';'); const i = kv!.indexOf('=');
        const k = kv!.slice(0, i), v = kv!.slice(i + 1);
        if (/max-age=0|expires=thu, 01 jan 1970/i.test(sc) || v === '') this.jar.delete(k); else this.jar.set(k, v);
      }
      return res;
    }
    post(path: string, form: Record<string, string>, extra: HeadersInit = {}) {
      return this.req(path, { method: 'POST', body: new URLSearchParams(form), headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra } });
    }
    get csrf() { return this.jar.get('kore_csrf'); }
    /** JSON API call; sends the CSRF header unless `csrf: false`. */
    async api(method: string, path: string, body?: unknown, o: { csrf?: boolean } = {}) {
      if (!this.csrf) await this.req('/api/session');
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (o.csrf !== false) headers['x-csrf-token'] = this.csrf!;
      const res = await this.req('/api' + path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
    }
  }

  const setupPath = (url: string) => new URL(url).pathname.replace(/^\/setup\//, '');

  /** Complete a setup link in a fresh browser (signed in afterwards). */
  async function completeSetup(url: string, password = PW) {
    const b = new Browser();
    const r = await b.api('POST', `/setup/${setupPath(url)}`, { password });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return b;
  }
  async function login(email: string, password = PW, returnTo?: string) {
    const b = new Browser();
    const r = await b.api('POST', '/login', { email, password, returnTo });
    return { b, r };
  }
  let adminBrowser: Browser | undefined;
  async function admin() {
    adminBrowser ??= await completeSetup(adminLink);
    return adminBrowser;
  }
  async function createUser(o: { email: string; name?: string; role?: string; apps?: string[] }) {
    const r = await (await admin()).api('POST', '/admin/users', { name: 'User', ...o });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as { user: { id: string; email: string }; setupUrl: string };
  }
  /** Create a user and complete their setup; returns their signed-in browser. */
  async function user(email: string, apps: string[] = names, role = 'user') {
    const { user: u, setupUrl } = await createUser({ email, apps, role, name: 'Ada' });
    return { id: u.id, b: await completeSetup(setupUrl) };
  }

  return { config, db, app, sent, ctl, logs, adminLink, Browser, setupPath, completeSetup, login, admin, createUser, user };
}
export type Env = ReturnType<typeof makeEnv>;
export type BrowserT = InstanceType<Env['Browser']>;

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
export const redirectFor = (id: string) => (id === 'korecalendar-android' ? 'dev.qarasky.korecalendar:/oauth2redirect' : `http://${id}.test/cb`);
export const authz = (id: string, challenge: string, extra: Record<string, string> = {}) =>
  `/authorize?${new URLSearchParams({ client_id: id, redirect_uri: redirectFor(id), response_type: 'code', scope: 'openid profile email offline_access', state: 'st', nonce: 'nn', code_challenge: challenge, code_challenge_method: 'S256', ...extra })}`;
export const basic = (id: string, secret = `secret-${id}`) => ({ authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') });

/** authorize (with an existing session) + code exchange. */
export async function tokenFor(b: BrowserT, id: string) {
  const { verifier, challenge } = pkce();
  const a = await b.req(authz(id, challenge));
  assert.equal(a.status, 302, `authorize ${id}: ${a.status}`);
  const loc = new URL(a.headers.get('location')!);
  assert.equal(loc.searchParams.get('state'), 'st');
  const code = loc.searchParams.get('code')!;
  assert.ok(code, `no code: ${loc}`);
  const isPublic = id === 'korecalendar-android';
  const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirectFor(id), code_verifier: verifier, ...(isPublic && { client_id: id }) };
  const res = await b.post('/token', form, isPublic ? {} : basic(id));
  return { res, code, verifier };
}
export async function tokensFor(b: BrowserT, id: string) {
  const { res } = await tokenFor(b, id);
  assert.equal(res.status, 200);
  return await res.json() as { access_token: string; id_token: string; refresh_token?: string; scope: string };
}
