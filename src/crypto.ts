import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 32768, R = 8, P = 1, KEYLEN = 64;

function scryptAsync(pw: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((res, rej) =>
    scrypt(pw, salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? rej(e) : res(k))),
  );
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scryptAsync(pw, Buffer.from(salt, 'base64url'), +n!, +r!, +p!);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Used to equalize timing when the account doesn't exist. */
export const DUMMY_HASH = await hashPassword(randomBytes(8).toString('hex'));

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const sha256b64url = (s: string) => createHash('sha256').update(s).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
