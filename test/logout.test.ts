import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwt } from 'jose';
import { makeEnv, PW, pkce, authz, tokensFor, basic } from './helpers.ts';

test('GET /logout with a valid id_token_hint ends the session and redirects; back-channel fires', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com');
  const t = await tokensFor(b, 'kore');
  const out = await b.req('/logout?' + new URLSearchParams({ id_token_hint: t.id_token, post_logout_redirect_uri: 'http://kore.test/', state: 's' }));
  assert.equal(out.headers.get('location'), 'http://kore.test/?state=s');
  assert.match((await b.req(authz('koremind', pkce().challenge))).headers.get('location')!, /^\/login/);
  await e.app.idle();
  assert.equal(e.sent.length, 1);
  assert.equal(decodeJwt(e.sent[0]!.token).sid, decodeJwt(t.id_token).sid);
  // Session ended => the session's refresh tokens are dead and its access tokens are inactive.
  assert.equal((await b.post('/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token! }, basic('kore'))).status, 400);
  assert.equal(((await (await b.post('/introspect', { token: t.access_token }, basic('kore'))).json()) as any).active, false);
});

test('GET /logout: unregistered post_logout_redirect_uri is not followed', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com');
  const t = await tokensFor(b, 'kore');
  const evil = await b.req('/logout?' + new URLSearchParams({ id_token_hint: t.id_token, post_logout_redirect_uri: 'http://evil.test/' }));
  assert.equal(evil.status, 200);
  assert.equal(evil.headers.get('location'), null);
});

test('GET /logout without a hint shows a confirm page and ends nothing; POST needs CSRF', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com');
  await tokensFor(b, 'kore');
  const page = await b.req('/logout?' + new URLSearchParams({ client_id: 'kore', post_logout_redirect_uri: 'http://kore.test/', state: 'z' }));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Sign out of Kore ID\?/);
  assert.match(html, /method="post" action="\/logout"/);
  assert.match(html, /name="post_logout_redirect_uri" value="http:\/\/kore.test\/"/);
  assert.ok((await b.api('GET', '/session')).body.user, 'session still active');

  // Forged/garbage hints are treated as no hint.
  await b.req('/logout?id_token_hint=abc.def.ghi');
  assert.ok((await b.api('GET', '/session')).body.user);

  const noCsrf = await b.post('/logout', { client_id: 'kore', post_logout_redirect_uri: 'http://kore.test/' });
  assert.equal(noCsrf.status, 403);
  assert.ok((await b.api('GET', '/session')).body.user);

  const ok = await b.post('/logout', { csrf: b.csrf!, client_id: 'kore', post_logout_redirect_uri: 'http://kore.test/', state: 'z' });
  assert.equal(ok.headers.get('location'), 'http://kore.test/?state=z');
  assert.equal((await b.api('GET', '/session')).body.user, null);
  await e.app.idle();
  assert.equal(e.sent.length, 1);
});

test("a hint for a different user than the browser's session asks instead of signing out", async () => {
  const e = makeEnv();
  const ada = await e.user('ada@example.com');
  const bob = await e.user('bob@example.com');
  const t = await tokensFor(ada.b, 'kore');
  const r = await bob.b.req('/logout?' + new URLSearchParams({ id_token_hint: t.id_token }));
  assert.match(await r.text(), /Sign out of Kore ID\?/);
  assert.ok((await bob.b.api('GET', '/session')).body.user);
});

test('signing in as someone else ends the previous session', async () => {
  const e = makeEnv();
  await e.user('bob@example.com');
  const { b } = await e.user('ada@example.com');
  await tokensFor(b, 'kore');
  const r = await b.api('POST', '/login', { email: 'bob@example.com', password: PW });
  assert.equal(r.status, 200);
  await e.app.idle();
  assert.equal(e.sent.length, 1);
  assert.equal((await b.api('GET', '/session')).body.user.email, 'bob@example.com');
});
