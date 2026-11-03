import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { exportJWK, generateKeyPair, importJWK, calculateJwkThumbprint, type JWK, type CryptoKey } from 'jose';

export interface Keys {
  signKey: CryptoKey | Uint8Array;
  kid: string;
  /** Public JWKS (all keys, so old tokens stay verifiable after rotation). */
  jwks: { keys: JWK[] };
}

/**
 * Keys live in DATA_DIR/keys.json as an array of private JWKs. The first is the
 * signing key. To rotate: put a freshly generated key first and keep the old one.
 */
export async function loadKeys(dataDir: string): Promise<Keys> {
  let privates: JWK[];
  const file = `${dataDir}/keys.json`;
  if (dataDir !== ':memory:' && existsSync(file)) {
    privates = JSON.parse(readFileSync(file, 'utf8'));
  } else {
    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = await exportJWK(privateKey);
    jwk.kid = await calculateJwkThumbprint(jwk);
    jwk.alg = 'EdDSA';
    jwk.use = 'sig';
    privates = [jwk];
    if (dataDir !== ':memory:') {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(privates, null, 2), { mode: 0o600 });
    }
  }
  const first = privates[0]!;
  return {
    signKey: (await importJWK(first, 'EdDSA')) as CryptoKey,
    kid: first.kid!,
    jwks: { keys: privates.map(({ d: _d, ...pub }) => pub) },
  };
}
