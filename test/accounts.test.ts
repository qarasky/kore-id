import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jwtVerify, createLocalJWKSet, decodeJwt, decodeProtectedHeader } from 'jose';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, makeConfig, keys, ISS, ADMIN, PW, tokensFor, basic, pkce, authz } from './helpers.ts';
import { openDb } from '../src/db.ts';
import { createCore, bootstrapAdmin } from '../src/core.ts';

const jwks = createLocalJWKSet(keys.jwks);

test('bootstrap admin: setup link is single use, re-issued on restart until used, expires', async () => {
  const e = makeEnv();
  assert.match(e.adminLink, new RegExp(`^${ISS}/setup/[A-Za-z0-9_-]{43}$`));
  const admin = e.app.core.getUserByEmail(ADMIN)!;
  assert.equal(admin.role, 'admin');
  assert.equal(admin.password_hash, null);

  // "Restart" before the link was used: fresh link, old one dead.
  const second = bootstrapAdmin(e.config, e.db, e.app.core)!;
  assert.ok(second && second !== e.adminLink);
  const b = new e.Browser();
  assert.equal((await b.api('GET', `/setup/${e.setupPath(e.adminLink)}`)).status, 404);
  const info = await b.api('GET', `/setup/${e.setupPath(second)}`);
  assert.deepEqual(info.body, { email: ADMIN, name: 'Admin' });

  assert.equal((await b.api('POST', `/setup/${e.setupPath(second)}`, { password: 'short' })).body.error, 'invalid_password');
  const done = await b.api('POST', `/setup/${e.setupPath(second)}`, { password: PW });
  assert.equal(done.status, 200);
  assert.equal(done.body.redirect, '/account');
  const s = await b.api('GET', '/session');
  assert.equal(s.body.user.email, ADMIN);
  assert.equal(s.body.user.role, 'admin');
  assert.equal(typeof s.body.csrf, 'string');

  // Single use.
  assert.equal((await new e.Browser().api('POST', `/setup/${e.setupPath(second)}`, { password: PW })).status, 404);
  // Admin has a password now: no link on restart.
  assert.equal(bootstrapAdmin(e.config, e.db, e.app.core), null);

  // Expiry.
  const e2 = makeEnv();
  const { setupUrl } = await e2.createUser({ email: 'late@example.com' });
  e2.db.prepare('UPDATE setup_tokens SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
  assert.equal((await new e2.Browser().api('GET', `/setup/${e2.setupPath(setupUrl)}`)).status, 404);
  assert.equal((await new e2.Browser().api('POST', `/setup/${e2.setupPath(setupUrl)}`, { password: PW })).status, 404);
});

test('KORE_ID_ADMIN_EMAIL overrides the bootstrap admin', () => {
  const config = makeConfig({ adminEmail: 'boss@example.com' });
  const db = openDb(':memory:');
  assert.ok(bootstrapAdmin(config, db, createCore(config, db, keys)));
  assert.equal(createCore(config, db, keys).getUserByEmail('boss@example.com')?.role, 'admin');
});

test('migrates a pre-admin database in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kore-db-'));
  const old = new DatabaseSync(join(dir, 'auth.db'));
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE refresh_tokens (token_hash TEXT PRIMARY KEY, family TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_id TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users VALUES ('u1', 'old@example.com', 'Old', 'scrypt$x', 0, 1);
    INSERT INTO sessions VALUES ('h', 'u1', 9999999999, 1);`);
  old.close();
  const config = makeConfig();
  for (let i = 0; i < 2; i++) { // idempotent
    const db = openDb(dir);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get('u1') as any;
    assert.equal(u.role, 'user');
    assert.equal(u.password_hash, 'scrypt$x');
    assert.ok((db.prepare('SELECT sid FROM sessions').get() as any).sid);
    const core = createCore(config, db, keys);
    bootstrapAdmin(config, db, core);
    assert.equal(core.getUserByEmail(ADMIN)?.role, 'admin');
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, created_at) VALUES ('u2', 'nopw@example.com', 'N', NULL, 1)").run();
    db.close();
  }
});

test('non-admins are forbidden from the admin API; anonymous gets 401', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com');
  for (const [m, p] of [['GET', '/admin/users'], ['POST', '/admin/users'], ['GET', '/admin/apps'], ['GET', '/admin/audit'], ['POST', '/admin/users/x/reset']] as const) {
    const r = await b.api(m, p, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.error, 'forbidden');
    assert.equal((await new e.Browser().api(m, p, m === 'POST' ? {} : undefined)).status, 401);
  }
  assert.equal((await b.api('GET', '/me')).body.user.email, 'ada@example.com');
});

test('CSRF header is required on every /api mutation', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com');
  for (const [m, p] of [['POST', '/login'], ['PATCH', '/me'], ['POST', '/logout'], ['POST', '/me/sessions/revoke-all'], ['POST', '/admin/users']] as const) {
    const r = await b.api(m, p, {}, { csrf: false });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.error, 'csrf_failed');
  }
  const wrong = await b.req('/api/me', { method: 'PATCH', headers: { 'x-csrf-token': 'nope', 'content-type': 'application/json' }, body: '{"name":"X"}' });
  assert.equal(wrong.status, 403);
  assert.equal((await b.api('GET', '/session')).body.user.email, 'ada@example.com', 'still signed in');
});

test('login: wrong password, disabled and password-less accounts rejected', async () => {
  const e = makeEnv();
  await e.user('ada@example.com');
  assert.equal((await e.login('ada@example.com', 'nope nope nope')).r.body.error, 'invalid_credentials');
  assert.equal((await e.login('ADA@example.com')).r.status, 200);
  await e.createUser({ email: 'pending@example.com' });
  assert.equal((await e.login('pending@example.com', '')).r.status, 401);
});

test('last active admin cannot be demoted, disabled or deleted', async () => {
  const e = makeEnv();
  const a = await e.admin();
  const me = (await a.api('GET', '/me')).body.user;
  for (const body of [{ role: 'user' }, { disabled: true }]) {
    const r = await a.api('PATCH', `/admin/users/${me.id}`, body);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'last_admin');
  }
  assert.equal((await a.api('DELETE', `/admin/users/${me.id}`)).body.error, 'last_admin');
  // With a second admin, demotion works.
  await e.user('second@example.com', [], 'admin');
  assert.equal((await a.api('PATCH', `/admin/users/${me.id}`, { role: 'user' })).body.user.role, 'user');
});

test('disabling a user revokes sessions + tokens and fires back-channel logout', async () => {
  const e = makeEnv();
  const { id, b } = await e.user('ada@example.com');
  const kore = await tokensFor(b, 'kore');
  const mind = await tokensFor(b, 'koremind');
  await tokensFor(b, 'korecalendar-android'); // no backchannelLogoutUri: skipped
  const sid = decodeJwt(kore.access_token).sid;

  const r = await (await e.admin()).api('PATCH', `/admin/users/${id}`, { disabled: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.disabled, true);
  await e.app.idle();

  assert.deepEqual(e.sent.map((s) => s.url).sort(), ['http://kore.test/backchannel-logout', 'http://koremind.test/backchannel-logout']);
  for (const s of e.sent) {
    assert.equal(decodeProtectedHeader(s.token).typ, 'logout+jwt');
    const aud = new URL(s.url).hostname.split('.')[0]!;
    const { payload } = await jwtVerify(s.token, jwks, { issuer: ISS, audience: aud, typ: 'logout+jwt' });
    assert.equal(payload.sid, sid);
    assert.equal(payload.sub, id);
    assert.deepEqual(payload.events, { 'http://schemas.openid.net/event/backchannel-logout': {} });
    assert.equal(payload.nonce, undefined);
    assert.ok(payload.jti && payload.exp! - payload.iat! === 120);
  }
  assert.equal((await b.post('/token', { grant_type: 'refresh_token', refresh_token: kore.refresh_token! }, basic('kore'))).status, 400);
  assert.equal((await e.app.request(ISS + '/userinfo', { headers: { authorization: `Bearer ${mind.access_token}` } })).status, 401);
  assert.equal(((await (await b.post('/introspect', { token: kore.access_token }, basic('kore'))).json()) as any).active, false);
  assert.equal((await b.api('GET', '/session')).body.user, null);
  assert.equal((await e.login('ada@example.com')).r.status, 401);
});

test('back-channel delivery retries twice, then logs and gives up', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com', ['kore']);
  await tokensFor(b, 'kore');
  e.ctl.failNext = 5;
  const out = await b.api('POST', '/logout');
  assert.equal(out.status, 200); // never blocked on delivery
  await e.app.idle();
  assert.equal(e.sent.length, 3);
  assert.equal(new Set(e.sent.map((s) => s.token)).size, 1);
  assert.equal(e.logs.filter((l) => /back-channel logout to kore/.test(l)).length, 3);
});

test('admin: create, list, get, update apps/email, reset password, sign out, delete', async () => {
  const e = makeEnv();
  const a = await e.admin();
  const bad = await a.api('POST', '/admin/users', { email: 'x', name: 'X' });
  assert.equal(bad.body.error, 'invalid_email');
  assert.equal((await a.api('POST', '/admin/users', { email: 'x@example.com', name: 'X', apps: ['nope'] })).body.error, 'invalid_apps');
  const { user, setupUrl } = await e.createUser({ email: 'bob@example.com', name: 'Bob', apps: ['kore'] });
  assert.equal((await a.api('POST', '/admin/users', { email: 'BOB@example.com', name: 'B' })).status, 409);
  const bob = await e.completeSetup(setupUrl);

  const list = await a.api('GET', '/admin/users?q=bob');
  assert.equal(list.body.users.length, 1);
  assert.deepEqual(list.body.users[0].apps, ['kore']);
  assert.equal(list.body.users[0].hasPassword, true);
  assert.ok(list.body.users[0].lastLoginAt);
  const one = await a.api('GET', `/admin/users/${user.id}`);
  assert.equal(one.body.sessions.length, 1);

  // app access is enforced at /authorize
  assert.equal((await bob.req(authz('koremind', pkce().challenge))).status, 403);
  const upd = await a.api('PATCH', `/admin/users/${user.id}`, { apps: ['kore', 'koremind'], email: 'robert@example.com' });
  assert.deepEqual(upd.body.user.apps, ['kore', 'koremind']);
  assert.equal(upd.body.user.email, 'robert@example.com');
  assert.ok((await tokensFor(bob, 'koremind')).access_token);
  assert.deepEqual((await bob.api('GET', '/me/apps')).body.apps.map((x: any) => x.app), ['kore', 'koremind']);

  // reset: password + sessions gone, new link works
  const reset = await a.api('POST', `/admin/users/${user.id}/reset`);
  assert.match(reset.body.setupUrl, /\/setup\//);
  await e.app.idle();
  assert.equal(e.sent.length, 1); // koremind got tokens in bob's session
  assert.equal((await bob.api('GET', '/session')).body.user, null);
  assert.equal((await e.login('robert@example.com')).r.status, 401);
  const bob2 = await e.completeSetup(reset.body.setupUrl, 'another long password');
  assert.equal((await bob2.api('GET', '/me')).body.user.email, 'robert@example.com');

  assert.equal((await a.api('POST', `/admin/users/${user.id}/signout`)).status, 200);
  assert.equal((await bob2.api('GET', '/session')).body.user, null);

  const apps = await a.api('GET', '/admin/apps');
  const kore = apps.body.apps.find((x: any) => x.app === 'kore');
  assert.equal(kore.userCount, 2); // admin + bob
  const cal = apps.body.apps.find((x: any) => x.app === 'korecalendar');
  assert.deepEqual(cal.clients.map((c: any) => [c.id, c.public]), [['korecalendar', false], ['korecalendar-android', true]]);
  assert.equal(JSON.stringify(apps.body).includes('secretHash'), false);

  assert.equal((await a.api('DELETE', `/admin/users/${user.id}`)).status, 200);
  assert.equal((await a.api('GET', `/admin/users/${user.id}`)).status, 404);
});

test('me: profile, password change, sessions', async () => {
  const e = makeEnv();
  const { b } = await e.user('ada@example.com', ['kore']);
  const other = (await e.login('ada@example.com')).b;
  await tokensFor(other, 'kore');
  assert.equal((await b.api('PATCH', '/me', { name: '  Ada L. ' })).body.user.name, 'Ada L.');

  const sessions = (await b.api('GET', '/me/sessions')).body.sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((s: any) => s.current).length, 1);
  assert.deepEqual(sessions.find((s: any) => !s.current).apps, [{ app: 'kore', name: 'Kore' }]);

  assert.equal((await b.api('POST', '/me/password', { current: 'wrong wrong', next: 'new password 123' })).body.error, 'invalid_current_password');
  assert.equal((await b.api('POST', '/me/password', { current: PW, next: 'new password 123' })).status, 200);
  await e.app.idle();
  assert.equal(e.sent.length, 1, 'other device signed out via back-channel');
  assert.equal((await other.api('GET', '/session')).body.user, null);
  assert.ok((await b.api('GET', '/session')).body.user, 'current session survives');
  assert.equal((await e.login('ada@example.com', 'new password 123')).r.status, 200);

  const third = (await b.api('GET', '/me/sessions')).body.sessions.find((s: any) => !s.current);
  assert.equal((await b.api('DELETE', `/me/sessions/${third.id}`)).status, 200);
  assert.equal((await b.api('DELETE', `/me/sessions/${third.id}`)).status, 404);
  assert.equal((await b.api('POST', '/me/sessions/revoke-all')).status, 200);
  assert.equal((await b.api('GET', '/session')).body.user, null);
});

test('audit log records sign-ins, failures and admin actions, paginated', async () => {
  const e = makeEnv();
  const a = await e.admin();
  const { user } = await e.createUser({ email: 'bob@example.com' });
  await e.login('bob@example.com', 'wrong password');
  await a.api('PATCH', `/admin/users/${user.id}`, { disabled: true });
  await a.api('POST', `/admin/users/${user.id}/reset`);
  await e.login(ADMIN);

  const all = await a.api('GET', '/admin/audit');
  const actions = all.body.entries.map((x: any) => x.action);
  for (const want of ['admin_bootstrapped', 'setup_completed', 'user_created', 'login_failed', 'user_disabled', 'password_reset', 'login'])
    assert.ok(actions.includes(want), want);
  const created = all.body.entries.find((x: any) => x.action === 'user_created');
  assert.equal(created.actor.email, ADMIN);
  assert.equal(created.target.label, 'bob@example.com');
  assert.ok(created.time && 'ip' in created && 'userAgent' in created);

  const p1 = await a.api('GET', '/admin/audit?limit=2');
  assert.equal(p1.body.entries.length, 2);
  const p2 = await a.api('GET', `/admin/audit?limit=2&cursor=${p1.body.nextCursor}`);
  assert.ok(p2.body.entries[0].id < p1.body.entries[1].id);
  const byUser = await a.api('GET', `/admin/audit?user=${user.id}&action=user_disabled`);
  assert.equal(byUser.body.entries.length, 1);
});
