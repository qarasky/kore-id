import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { openDb, purgeExpired } from './db.ts';
import { loadKeys } from './keys.ts';
import { createApp } from './app.ts';
import { bootstrapAdmin } from './core.ts';

const config = loadConfig();
if (config.clients.size === 0) console.warn('No clients registered. Run `npm run init-clients` and edit clients.json.');
const db = openDb(config.dataDir);
const keys = await loadKeys(config.dataDir);
const app = createApp(config, db, keys);

const setupUrl = bootstrapAdmin(config, db, app.core);
if (setupUrl) console.log(`\nAdmin ${config.adminEmail} has no password yet. One-time setup link (valid 24h):\n  ${setupUrl}\n`);

// Housekeeping: purge expired rows hourly.
setInterval(() => purgeExpired(db), 3600_000).unref();

serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`Kore ID listening on :${i.port} (issuer ${config.issuer})`));
