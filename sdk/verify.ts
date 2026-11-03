/**
 * Drop-in token verification for Kore apps (backends). Copy this file or import it.
 *
 *   const verify = createVerifier({ issuer: 'https://id.kore.example', audience: 'koremind' });
 *   const { sub, email } = await verify(bearerToken);
 *
 * `audience` is the app's own client id, so a token minted for one app is rejected by the others.
 * `sub` is the stable user id shared by all four apps: key your user rows on it.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function createVerifier(opts: { issuer: string; audience: string }) {
  const jwks = createRemoteJWKSet(new URL(`${opts.issuer}/.well-known/jwks.json`));
  return async (token: string) => {
    const { payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audience, algorithms: ['EdDSA'] });
    return { sub: payload.sub!, email: payload.email as string | undefined, scope: String(payload.scope ?? '') };
  };
}
