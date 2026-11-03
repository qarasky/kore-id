import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';

const file = process.env.CLIENTS_FILE ?? 'clients.json';
if (existsSync(file) && !process.argv.includes('--force')) {
  console.error(`${file} already exists (use --force to overwrite; secrets will change).`);
  process.exit(1);
}

// Edit the URLs afterwards. "flatline" becomes "koremonitor" after the rename: add a new entry, keep both during migration.
const apps = [
  { id: 'kore', name: 'Kore', port: 3001 },
  { id: 'koremind', name: 'KoreMind', port: 3002 },
  { id: 'korecalendar', name: 'KoreCalendar', port: 3003 },
  { id: 'flatline', name: 'Flatline (KoreMonitor)', port: 3004 },
];

const secrets: Record<string, string> = {};
const clients: Record<string, unknown>[] = apps.map((a) => {
  const secret = randomBytes(32).toString('base64url');
  secrets[a.id] = secret;
  return {
    id: a.id,
    name: a.name,
    app: a.id,
    secretHash: createHash('sha256').update(secret).digest('hex'),
    redirectUris: [`http://localhost:${a.port}/auth/callback`],
    postLogoutRedirectUris: [`http://localhost:${a.port}/`],
    backchannelLogoutUri: `http://localhost:${a.port}/auth/backchannel-logout`,
    homeUrl: `http://localhost:${a.port}/`,
  };
});
// Native Android app: public client (PKCE only, no secret), shares KoreCalendar's app access.
clients.push({
  id: 'korecalendar-android',
  name: 'KoreCalendar (Android)',
  app: 'korecalendar',
  redirectUris: ['dev.qarasky.korecalendar:/oauth2redirect'],
  postLogoutRedirectUris: [],
});
writeFileSync(file, JSON.stringify(clients, null, 2), { mode: 0o600 });
console.log(`Wrote ${file}. Client secrets (shown ONCE, store them in each app's env):\n`);
for (const [id, s] of Object.entries(secrets)) console.log(`  ${id}: ${s}`);
console.log('\n  korecalendar-android: public client, no secret');
