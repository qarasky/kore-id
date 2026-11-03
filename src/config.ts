import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Client {
  id: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /** sha256 hex of the client secret. Absent => public client (PKCE only). */
  secretHash?: string;
  /** App key for access control. Several clients may share one app (e.g. web + Android). Default: the client id. */
  app: string;
  /** Absolute URL Kore ID POSTs OIDC back-channel logout tokens to. */
  backchannelLogoutUri?: string;
  /** Shown in the account page's app launcher. */
  homeUrl?: string;
}

export interface Config {
  issuer: string;
  port: number;
  dataDir: string;
  secureCookies: boolean;
  trustProxy: boolean;
  /** Bootstrap admin, created on first start with an empty DB. */
  adminEmail: string;
  /** Built SPA (`web/dist`). Served for /login, /setup/:token, /account, /admin when present. */
  webDir: string;
  clients: Map<string, Client>;
}

const absUrl = (v: unknown, what: string) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^https?:\/\//.test(v)) throw new Error(`${what} must be an absolute http(s) URL`);
  new URL(v);
  return v;
};

export function parseClients(raw: Partial<Client>[]): Map<string, Client> {
  const clients = new Map<string, Client>();
  for (const c of raw) {
    if (!c.id || !c.redirectUris?.length) throw new Error(`Invalid client entry: ${JSON.stringify(c)}`);
    clients.set(c.id, {
      id: c.id,
      name: c.name ?? c.id,
      redirectUris: c.redirectUris,
      postLogoutRedirectUris: c.postLogoutRedirectUris ?? [],
      secretHash: c.secretHash,
      app: c.app || c.id,
      backchannelLogoutUri: absUrl(c.backchannelLogoutUri, `${c.id}.backchannelLogoutUri`),
      homeUrl: absUrl(c.homeUrl, `${c.id}.homeUrl`),
    });
  }
  return clients;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issuer = (env.ISSUER ?? `http://localhost:${env.PORT ?? 4000}`).replace(/\/$/, '');
  const clientsFile = env.CLIENTS_FILE ?? 'clients.json';
  const clients = existsSync(clientsFile) ? parseClients(JSON.parse(readFileSync(clientsFile, 'utf8'))) : new Map<string, Client>();
  return {
    issuer,
    port: Number(env.PORT ?? 4000),
    dataDir: env.DATA_DIR ?? 'data',
    secureCookies: issuer.startsWith('https://'),
    trustProxy: env.TRUST_PROXY === 'true',
    adminEmail: (env.KORE_ID_ADMIN_EMAIL ?? 'sky@qarasky.dev').trim().toLowerCase(),
    webDir: env.WEB_DIR ?? fileURLToPath(new URL('../web/dist', import.meta.url)),
    clients,
  };
}
