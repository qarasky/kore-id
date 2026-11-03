import { readFileSync, existsSync } from 'node:fs';

export interface Client {
  id: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /** sha256 hex of the client secret. Absent => public client (PKCE only). */
  secretHash?: string;
}

export interface Config {
  issuer: string;
  port: number;
  dataDir: string;
  secureCookies: boolean;
  allowRegistration: boolean;
  trustProxy: boolean;
  clients: Map<string, Client>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issuer = (env.ISSUER ?? `http://localhost:${env.PORT ?? 4000}`).replace(/\/$/, '');
  const clientsFile = env.CLIENTS_FILE ?? 'clients.json';
  const clients = new Map<string, Client>();
  if (existsSync(clientsFile)) {
    const raw = JSON.parse(readFileSync(clientsFile, 'utf8')) as Partial<Client>[];
    for (const c of raw) {
      if (!c.id || !c.redirectUris?.length) throw new Error(`Invalid client entry: ${JSON.stringify(c)}`);
      clients.set(c.id, {
        id: c.id,
        name: c.name ?? c.id,
        redirectUris: c.redirectUris,
        postLogoutRedirectUris: c.postLogoutRedirectUris ?? [],
        secretHash: c.secretHash,
      });
    }
  }
  return {
    issuer,
    port: Number(env.PORT ?? 4000),
    dataDir: env.DATA_DIR ?? 'data',
    secureCookies: issuer.startsWith('https://'),
    allowRegistration: (env.ALLOW_REGISTRATION ?? 'true') === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    clients,
  };
}
