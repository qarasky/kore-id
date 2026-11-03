import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { loadKeys } from '../src/keys.ts';
import type { Config } from '../src/config.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ISS = 'http://auth.test';
const names = ['kore', 'koremind', 'korecalendar', 'flatline'];
const config: Config = {
  issuer: ISS, port: 0, dataDir: ':memory:', secureCookies: false, allowRegistration: true, trustProxy: false,
  clients: new Map(names.map((id) => [id, {
    id, name: id, secretHash: sha(`secret-${id}`),
    redirectUris: [`http://${id}.test/cb`], postLogoutRedirectUris: [`http://${id}.test/`],
  }])),
};
const keys = await loadKeys(':memory:');
const app = createApp(config, openDb(':memory:'), keys);

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
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
const authz = (id: string, challenge: string, extra: Record<string, string> = {}) =>
  `/authorize?${new URLSearchParams({ client_id: id, redirect_uri: `http://${id}.test/cb`, response_type: 'code', scope: 'openid profile email offline_access', state: 'st', nonce: 'nn', code_challenge: challenge, code_challenge_method: 'S256', ...extra })}`;
const basic = (id: string) => ({ authorization: 'Basic ' + Buffer.from(`${id}:secret-${id}`).toString('base64') });
const csrf = (b: Browser) => b.jar.get('kore_csrf')!;

async function register(b: Browser, ret = '') {
  await b.req('/register');
  return b.post('/register', { csrf: csrf(b), return_to: ret, name: 'Ada', email: 'Ada@Example.com', password: 'correct horse battery' });
}
async function tokenFor(b: Browser, id: string) {
  const { verifier, challenge } = pkce();
  const a = await b.req(authz(id, challenge));
  assert.equal(a.status, 302);
  const loc = new URL(a.headers.get('location')!);
  assert.equal(loc.origin, `http://${id}.test`);
  assert.equal(loc.searchParams.get('state'), 'st');
  const code = loc.searchParams.get('code')!;
  const t = await b.post('/token', { grant_type: 'authorization_code', code, redirect_uri: `http://${id}.test/cb`, code_verifier: verifier }, basic(id));
  return { res: t, code, verifier };
}

test('one account, one login, SSO into all four apps', async () => {
  const b = new Browser();
  // Kore sends the user to authorize -> bounced to login
  const { challenge } = pkce();
  const first = await b.req(authz('kore', challenge));
  assert.match(first.headers.get('location')!, /^\/login\?return_to=/);
  const returnTo = new URL(first.headers.get('location')!, ISS).searchParams.get('return_to')!;
  const reg = await register(b, returnTo);
  assert.equal(reg.status, 302);
  assert.equal(reg.headers.get('location'), returnTo);

  const subs = new Set<string>();
  for (const id of names) {
    const { res } = await tokenFor(b, id); // no further login prompts
    assert.equal(res.status, 200);
    const tok = await res.json() as any;
    const { payload } = await jwtVerify(tok.access_token, createLocalJWKSet(keys.jwks), { issuer: ISS, audience: id });
    assert.equal(payload.email, 'ada@example.com');
    const idt = await jwtVerify(tok.id_token, createLocalJWKSet(keys.jwks), { issuer: ISS, audience: id });
    assert.equal(idt.payload.nonce, 'nn');
    assert.equal(idt.payload.name, 'Ada');
    subs.add(payload.sub!);
    const ui = await app.request(ISS + '/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } });
    assert.equal((await ui.json() as any).email, 'ada@example.com');
  }
  assert.equal(subs.size, 1, 'same sub across all apps');
});

test('login with existing account from a fresh browser; wrong password rejected', async () => {
  const b = new Browser();
  await b.req('/login');
  const bad = await b.post('/login', { csrf: csrf(b), email: 'ada@example.com', password: 'nope' });
  assert.equal(bad.status, 400);
  const ok = await b.post('/login', { csrf: csrf(b), email: 'ADA@example.com', password: 'correct horse battery' });
  assert.equal(ok.status, 302);
  assert.equal((await tokenFor(b, 'koremind')).res.status, 200);
});

test('csrf is enforced on login', async () => {
  const b = new Browser();
  await b.req('/login');
  const r = await b.post('/login', { csrf: 'wrong', email: 'ada@example.com', password: 'correct horse battery' });
  assert.equal(r.status, 403);
});

test('code is single use; PKCE and secret enforced; audience-bound', async () => {
  const b = new Browser();
  await b.req('/login');
  await b.post('/login', { csrf: csrf(b), email: 'ada@example.com', password: 'correct horse battery' });

  const { code, verifier, res } = await tokenFor(b, 'kore');
  assert.equal(res.status, 200);
  const replay = await b.post('/token', { grant_type: 'authorization_code', code, redirect_uri: 'http://kore.test/cb', code_verifier: verifier }, basic('kore'));
  assert.equal(replay.status, 400);

  const { challenge } = pkce();
  const loc = new URL((await b.req(authz('kore', challenge))).headers.get('location')!);
  const wrongVerifier = await b.post('/token', { grant_type: 'authorization_code', code: loc.searchParams.get('code')!, redirect_uri: 'http://kore.test/cb', code_verifier: randomBytes(32).toString('base64url') }, basic('kore'));
  assert.equal(wrongVerifier.status, 400);

  const loc2 = new URL((await b.req(authz('kore', pkce().challenge))).headers.get('location')!);
  const badSecret = await b.post('/token', { grant_type: 'authorization_code', code: loc2.searchParams.get('code')!, redirect_uri: 'http://kore.test/cb', code_verifier: 'x'.repeat(43) }, { authorization: 'Basic ' + Buffer.from('kore:wrong').toString('base64') });
  assert.equal(badSecret.status, 401);

  // token for koremind must not validate for kore
  const km = await (await tokenFor(b, 'koremind')).res.json() as any;
  await assert.rejects(jwtVerify(km.access_token, createLocalJWKSet(keys.jwks), { issuer: ISS, audience: 'kore' }));
});

test('authorize rejects unregistered redirect_uri without redirecting, requires PKCE', async () => {
  const b = new Browser();
  const bad = await b.req(authz('kore', pkce().challenge, { redirect_uri: 'http://evil.test/cb' }));
  assert.equal(bad.status, 400);
  const nop = await b.req('/authorize?' + new URLSearchParams({ client_id: 'kore', redirect_uri: 'http://kore.test/cb', response_type: 'code', scope: 'openid' }));
  assert.match(nop.headers.get('location')!, /error=invalid_request/);
});

test('open redirect via return_to is blocked', async () => {
  const b = new Browser();
  await b.req('/login');
  const r = await b.post('/login', { csrf: csrf(b), email: 'ada@example.com', password: 'correct horse battery', return_to: 'https://evil.test/' });
  assert.equal(r.headers.get('location'), '/account');
});

test('prompt=none without session returns login_required', async () => {
  const r = await new Browser().req(authz('kore', pkce().challenge, { prompt: 'none' }));
  assert.match(r.headers.get('location')!, /error=login_required/);
});

test('refresh rotation and reuse detection', async () => {
  const b = new Browser();
  await b.req('/login');
  await b.post('/login', { csrf: csrf(b), email: 'ada@example.com', password: 'correct horse battery' });
  const t1 = await (await tokenFor(b, 'kore')).res.json() as any;
  const refresh = (rt: string) => b.post('/token', { grant_type: 'refresh_token', refresh_token: rt }, basic('kore'));
  const r2 = await refresh(t1.refresh_token);
  assert.equal(r2.status, 200);
  const t2 = await r2.json() as any;
  assert.notEqual(t2.refresh_token, t1.refresh_token);
  assert.equal((await refresh(t1.refresh_token)).status, 400); // reuse
  assert.equal((await refresh(t2.refresh_token)).status, 400); // family revoked
});

test('refresh token is bound to its client', async () => {
  const b = new Browser();
  await b.req('/login');
  await b.post('/login', { csrf: csrf(b), email: 'ada@example.com', password: 'correct horse battery' });
  const t = await (await tokenFor(b, 'kore')).res.json() as any;
  const r = await b.post('/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token }, basic('koremind'));
  assert.equal(r.status, 400);
});

test('logout ends SSO session; post-logout redirect validated', async () => {
  const b = new Browser();
  await b.req('/login');
  await b.post('/login', { csrf: csrf(b), email: 'ada@example.com', password: 'correct horse battery' });
  const t = await (await tokenFor(b, 'kore')).res.json() as any;
  const out = await b.req('/logout?' + new URLSearchParams({ id_token_hint: t.id_token, post_logout_redirect_uri: 'http://kore.test/', state: 's' }));
  assert.equal(out.headers.get('location'), 'http://kore.test/?state=s');
  const again = await b.req(authz('koremind', pkce().challenge));
  assert.match(again.headers.get('location')!, /^\/login/);
  const evil = await b.req('/logout?' + new URLSearchParams({ id_token_hint: t.id_token, post_logout_redirect_uri: 'http://evil.test/' }));
  assert.equal(evil.status, 200);
});
