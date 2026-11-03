import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { jwtVerify, createLocalJWKSet, decodeProtectedHeader, decodeJwt } from 'jose';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, keys, ISS, PW, names, pkce, authz, basic, tokenFor, tokensFor } from './helpers.ts';

const jwks = createLocalJWKSet(keys.jwks);

test('admin creates user -> setup -> login -> SSO into every allowed app (one sub, typed tokens)', async () => {
  const e = makeEnv();
  const { setupUrl } = await e.createUser({ email: 'Ada@Example.com', name: 'Ada', apps: ['kore', 'koremind', 'korecalendar', 'flatline'] });
  await e.completeSetup(setupUrl);

  // Fresh browser: app sends the user to /authorize -> bounced to the SPA login with return_to.
  const b = new e.Browser();
  const first = await b.req(authz('kore', pkce().challenge));
  assert.match(first.headers.get('location')!, /^\/login\?return_to=/);
  const returnTo = new URL(first.headers.get('location')!, ISS).searchParams.get('return_to')!;
  const login = await b.api('POST', '/login', { email: 'ADA@example.com', password: PW, returnTo });
  assert.equal(login.status, 200);
  assert.equal(login.body.redirect, returnTo);

  const subs = new Set<string>(), sids = new Set<string>();
  for (const id of [...names, 'korecalendar-android']) {
    const tok = await tokensFor(b, id); // no further login prompts
    assert.equal(decodeProtectedHeader(tok.access_token).typ, 'at+jwt');
    assert.equal(decodeProtectedHeader(tok.id_token).typ, 'JWT');
    const { payload: at } = await jwtVerify(tok.access_token, jwks, { issuer: ISS, audience: id, typ: 'at+jwt' });
    assert.equal(at.client_id, id);
    assert.equal(at.email, 'ada@example.com');
    assert.equal(at.email_verified, true);
    assert.ok(at.jti && at.sid && at.scope);
    const { payload: idt } = await jwtVerify(tok.id_token, jwks, { issuer: ISS, audience: id, typ: 'JWT' });
    assert.equal(idt.nonce, 'nn');
    assert.equal(idt.name, 'Ada');
    assert.equal(idt.azp, id);
    assert.equal(idt.sid, at.sid);
    assert.equal(typeof idt.auth_time, 'number');
    assert.equal(idt.email_verified, true);
    assert.equal(idt.scope, undefined, 'id token has no scope claim');
    subs.add(at.sub!); sids.add(String(at.sid));
    const ui = await e.app.request(ISS + '/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } });
    const info = await ui.json() as any;
    assert.equal(info.email, 'ada@example.com');
    assert.equal(info.email_verified, true);
    // An id token is not an access token.
    const bad = await e.app.request(ISS + '/userinfo', { headers: { authorization: `Bearer ${tok.id_token}` } });
    assert.equal(bad.status, 401);
  }
  assert.equal(subs.size, 1, 'same sub across all apps');
  assert.equal(sids.size, 1, 'one browser session');
});

test('discovery advertises introspection and back-channel logout', async () => {
  const d = await (await makeEnv().app.request(ISS + '/.well-known/openid-configuration')).json() as any;
  assert.equal(d.introspection_endpoint, `${ISS}/introspect`);
  assert.equal(d.backchannel_logout_supported, true);
  assert.equal(d.backchannel_logout_session_supported, true);
});

test('app access: denied page, prompt=none error, grouped clients share access', async () => {
  const e = makeEnv();
  const { b } = await e.user('cal@example.com', ['korecalendar']);
  const denied = await b.req(authz('kore', pkce().challenge));
  assert.equal(denied.status, 403);
  const html = await denied.text();
  assert.match(html, /You don't have access to Kore/);
  assert.match(html, /Sign in as someone else/);
  assert.match(html, /prompt=login/);
  assert.equal(denied.headers.get('location'), null, 'never a code');
  const none = await b.req(authz('kore', pkce().challenge, { prompt: 'none' }));
  assert.match(none.headers.get('location')!, /error=access_denied/);
  // korecalendar-android belongs to app korecalendar
  assert.ok((await tokensFor(b, 'korecalendar')).access_token);
  assert.ok((await tokensFor(b, 'korecalendar-android')).access_token);
  // Admins can use every app.
  assert.ok((await tokensFor(await e.admin(), 'flatline')).access_token);
});

test('code is single use; PKCE and secret enforced; audience-bound', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com');
  const { code, verifier, res } = await tokenFor(b, 'kore');
  assert.equal(res.status, 200);
  const replay = await b.post('/token', { grant_type: 'authorization_code', code, redirect_uri: 'http://kore.test/cb', code_verifier: verifier }, basic('kore'));
  assert.equal(replay.status, 400);

  const loc = new URL((await b.req(authz('kore', pkce().challenge))).headers.get('location')!);
  const wrongVerifier = await b.post('/token', { grant_type: 'authorization_code', code: loc.searchParams.get('code')!, redirect_uri: 'http://kore.test/cb', code_verifier: randomBytes(32).toString('base64url') }, basic('kore'));
  assert.equal(wrongVerifier.status, 400);

  const loc2 = new URL((await b.req(authz('kore', pkce().challenge))).headers.get('location')!);
  const badSecret = await b.post('/token', { grant_type: 'authorization_code', code: loc2.searchParams.get('code')!, redirect_uri: 'http://kore.test/cb', code_verifier: 'x'.repeat(43) }, basic('kore', 'wrong'));
  assert.equal(badSecret.status, 401);

  const km = await tokensFor(b, 'koremind');
  await assert.rejects(jwtVerify(km.access_token, jwks, { issuer: ISS, audience: 'kore' }));
});

test('malformed Basic auth -> 401 invalid_client, never 500', async () => {
  const e = makeEnv();
  const bad = ['Basic !!!', 'Basic', 'Basic ' + Buffer.from('nocolon').toString('base64'), 'Basic ' + Buffer.from('%E0%A4%A:x').toString('base64'),
    'Basic ' + Buffer.from(':secret').toString('base64'), 'Bearer abc', 'Basic ' + Buffer.from('kore:%zz').toString('base64')];
  for (const authorization of bad) {
    for (const path of ['/token', '/revoke', '/introspect']) {
      const r = await e.app.request(ISS + path, { method: 'POST', headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&token=x' });
      assert.equal(r.status, 401, `${path} ${authorization}`);
      assert.equal((await r.json() as any).error, 'invalid_client');
    }
  }
});

test('authorize rejects unregistered redirect_uri without redirecting, requires PKCE', async () => {
  const b = new (makeEnv().Browser)();
  const bad = await b.req(authz('kore', pkce().challenge, { redirect_uri: 'http://evil.test/cb' }));
  assert.equal(bad.status, 400);
  const nop = await b.req('/authorize?' + new URLSearchParams({ client_id: 'kore', redirect_uri: 'http://kore.test/cb', response_type: 'code', scope: 'openid' }));
  assert.match(nop.headers.get('location')!, /error=invalid_request/);
});

test('open redirect via returnTo is blocked', async () => {
  const e = makeEnv();
  await e.user('ada@example.com');
  for (const returnTo of ['https://evil.test/', '//evil.test/authorize?x', '/authorize\\@evil.test', '/account']) {
    const { r } = await e.login('ada@example.com', PW, returnTo);
    assert.equal(r.body.redirect, '/account', returnTo);
  }
});

test('prompt=none without session returns login_required', async () => {
  const r = await new (makeEnv().Browser)().req(authz('kore', pkce().challenge, { prompt: 'none' }));
  assert.match(r.headers.get('location')!, /error=login_required/);
});

test('refresh rotation and reuse detection; refresh bound to its client', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com');
  const t1 = await tokensFor(b, 'kore');
  const refresh = (rt: string, id = 'kore') => b.post('/token', { grant_type: 'refresh_token', refresh_token: rt }, basic(id));
  assert.equal((await refresh(t1.refresh_token!, 'koremind')).status, 400);
  const r2 = await refresh(t1.refresh_token!);
  assert.equal(r2.status, 200);
  const t2 = await r2.json() as any;
  assert.notEqual(t2.refresh_token, t1.refresh_token);
  assert.equal(decodeJwt(t2.access_token).sid, decodeJwt(t1.access_token).sid, 'refresh keeps the sid');
  assert.equal((await refresh(t1.refresh_token!)).status, 400); // reuse
  assert.equal((await refresh(t2.refresh_token)).status, 400); // family revoked
});

test('introspection: active/inactive, own tokens only', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com');
  const t = await tokensFor(b, 'kore');
  const introspect = async (token: string, id = 'kore') => (await (await b.post('/introspect', { token }, basic(id))).json()) as any;
  const a = await introspect(t.access_token);
  assert.equal(a.active, true);
  assert.equal(a.client_id, 'kore');
  assert.equal(a.sid, decodeJwt(t.access_token).sid);
  assert.equal(typeof a.exp, 'number');
  assert.match(a.scope, /openid/);
  assert.equal((await introspect(t.refresh_token!)).active, true);
  assert.equal((await introspect(t.access_token, 'koremind')).active, false, "another client's token");
  assert.equal((await introspect(t.id_token)).active, false, 'id token is not an access token');
  assert.equal((await introspect('garbage')).active, false);
  const unauth = await b.post('/introspect', { token: t.access_token });
  assert.equal(unauth.status, 401);
});

test('revoking an access token (jti denylist) makes it inactive and rejected at /userinfo', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com');
  const t = await tokensFor(b, 'kore');
  const ui = () => e.app.request(ISS + '/userinfo', { headers: { authorization: `Bearer ${t.access_token}` } });
  assert.equal((await ui()).status, 200);
  // Another client can't revoke it.
  assert.equal((await b.post('/revoke', { token: t.access_token }, basic('koremind'))).status, 200);
  assert.equal((await ui()).status, 200);
  assert.equal((await b.post('/revoke', { token: t.access_token }, basic('kore'))).status, 200);
  assert.equal((await ui()).status, 401);
  assert.equal(((await (await b.post('/introspect', { token: t.access_token }, basic('kore'))).json()) as any).active, false);
  // Refresh tokens still revocable.
  assert.equal((await b.post('/revoke', { token: t.refresh_token! }, basic('kore'))).status, 200);
  assert.equal((await b.post('/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token! }, basic('kore'))).status, 400);
});

test('/register and the old HTML forms are gone; SPA routes need web/dist', async () => {
  const e = makeEnv();
  assert.equal((await e.app.request(ISS + '/register')).status, 404);
  assert.equal((await e.app.request(ISS + '/register', { method: 'POST' })).status, 404);
  const nb = await e.app.request(ISS + '/login');
  assert.equal(nb.status, 503);
  assert.match(await nb.text(), /not built/);

  const dir = mkdtempSync(join(tmpdir(), 'kore-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
  const w = makeEnv({ webDir: dir });
  for (const p of ['/login', '/setup/abc', '/account', '/admin/users']) {
    const r = await w.app.request(ISS + p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /id="root"/);
    assert.match(r.headers.get('content-security-policy')!, /script-src 'self'/);
  }
  const js = await w.app.request(ISS + '/assets/app-abc.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control')!, /immutable/);
  assert.match(js.headers.get('content-type')!, /javascript/);
  assert.equal((await w.app.request(ISS + '/assets/..%2Findex.html')).status, 404);
  assert.equal((await w.app.request(ISS + '/assets/nope.js')).status, 404);
});
