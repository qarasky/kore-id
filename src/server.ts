import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { loadKeys } from './keys.ts';
import { createApp } from './app.ts';

const config = loadConfig();
if (config.clients.size === 0) console.warn('No clients registered. Run `npm run init-clients` and edit clients.json.');
const db = openDb(config.dataDir);
const keys = await loadKeys(config.dataDir);
const app = createApp(config, db, keys);

// Housekeeping: purge expired rows hourly.
setInterval(() => {
  const t = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(t);
}, 3600_000).unref();

serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`Kore ID listening on :${i.port} (issuer ${config.issuer})`));
