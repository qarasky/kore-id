import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet } from 'jose';
import { makeEnv, keys, ISS, tokensFor } from './helpers.ts';
import { createVerifier, createLogoutVerifier } from '../sdk/verify.ts';

const jwks = createLocalJWKSet(keys.jwks);

test('sdk: access tokens only; logout tokens verified once', async () => {
  const e = makeEnv();
  const { id, b } = await e.user('ada@example.com', ['kore']);
  const t = await tokensFor(b, 'kore');
  const verify = createVerifier({ issuer: ISS, audience: 'kore', jwks });
  const v = await verify(t.access_token);
  assert.equal(v.sub, id);
  assert.equal(v.emailVerified, true);
  assert.ok(v.sid);
  await assert.rejects(verify(t.id_token), 'id token rejected as bearer');
  await assert.rejects(createVerifier({ issuer: ISS, audience: 'koremind', jwks })(t.access_token));

  await b.api('POST', '/logout');
  await e.app.idle();
  const logoutToken = e.sent[0]!.token;
  const verifyLogout = createLogoutVerifier({ issuer: ISS, audience: 'kore', jwks });
  await assert.rejects(createLogoutVerifier({ issuer: ISS, audience: 'koremind', jwks })(logoutToken));
  await assert.rejects(verifyLogout(t.access_token), 'access token is not a logout token');
  const out = await verifyLogout(logoutToken);
  assert.equal(out.sid, v.sid);
  assert.equal(out.sub, id);
  await assert.rejects(verifyLogout(logoutToken), /replayed/);
});
