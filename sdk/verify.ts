/**
 * Drop-in token verification for Kore apps (backends). Copy this file or import it.
 *
 *   const verify = createVerifier({ issuer: 'https://id.kore.example', audience: 'koremind' });
 *   const { sub, email, sid } = await verify(bearerToken);
 *
 * `audience` is the app's own client id, so a token minted for one app is rejected by the others.
 * Only access tokens (header `typ: at+jwt`) are accepted; an id token used as a bearer token is rejected.
 * `sub` is the stable user id shared by all four apps: key your user rows on it.
 *
 * Back-channel logout (POST <app>/…/backchannel-logout, form field `logout_token`):
 *
 *   const verifyLogout = createLogoutVerifier({ issuer, audience: 'koremind' });
 *   try { const { sid, sub } = await verifyLogout(form.get('logout_token')); deleteSessions(sid ? { sid } : { sub }); return 200; }
 *   catch { return 400; }
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const jwksFor = (issuer: string) => createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

export function createVerifier(opts: { issuer: string; audience: string; jwks?: JWTVerifyGetKey }) {
  const jwks = opts.jwks ?? jwksFor(opts.issuer);
  return async (token: string) => {
    const { payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audience, algorithms: ['EdDSA'], typ: 'at+jwt' });
    return {
      sub: payload.sub!,
      sid: payload.sid as string | undefined,
      clientId: payload.client_id as string | undefined,
      email: payload.email as string | undefined,
      emailVerified: payload.email_verified === true,
      scope: String(payload.scope ?? ''),
    };
  };
}

/**
 * Verifies an OIDC Back-Channel Logout token: signature (JWKS), iss, aud = own client id, `typ: logout+jwt`,
 * `events` claim present, no `nonce`, sid or sub present, and jti not seen before (replay; in-memory unless you pass
 * your own `seen` store, which you should when running several instances).
 */
export function createLogoutVerifier(opts: {
  issuer: string; audience: string; jwks?: JWTVerifyGetKey;
  /** Returns true if `jti` was already seen; otherwise records it until `exp` (seconds). */
  seen?: (jti: string, exp: number) => boolean | Promise<boolean>;
}) {
  const jwks = opts.jwks ?? jwksFor(opts.issuer);
  const memory = new Map<string, number>();
  const seen = opts.seen ?? ((jti: string, exp: number) => {
    const t = Math.floor(Date.now() / 1000);
    for (const [k, e] of memory) if (e < t) memory.delete(k);
    if (memory.has(jti)) return true;
    memory.set(jti, exp);
    return false;
  });
  return async (token: string | null | undefined) => {
    if (!token) throw new Error('logout_token missing');
    const { payload } = await jwtVerify(token, jwks, {
      issuer: opts.issuer, audience: opts.audience, algorithms: ['EdDSA'], typ: 'logout+jwt', requiredClaims: ['iat', 'exp', 'jti'],
    });
    const events = payload.events as Record<string, unknown> | undefined;
    if (!events || typeof events !== 'object' || !(BACKCHANNEL_EVENT in events)) throw new Error('logout token: events claim missing');
    if ('nonce' in payload) throw new Error('logout token: nonce not allowed');
    const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
    if (!sid && !payload.sub) throw new Error('logout token: sid or sub required');
    if (await seen(payload.jti!, payload.exp!)) throw new Error('logout token: replayed');
    return { sub: payload.sub, sid, jti: payload.jti! };
  };
}
