import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';

const file = process.env.CLIENTS_FILE ?? 'clients.json';
if (existsSync(file) && !process.argv.includes('--force')) {
  console.error(`${file} already exists (use --force to overwrite; secrets will change).`);
  process.exit(1);
}

// Edit the URLs afterwards. "flatline" becomes "korem monitor" after the rename: add a new entry, keep both during migration.
const apps = [
  { id: 'kore', name: 'Kore', port: 3001 },
  { id: 'koremind', name: 'KoreMind', port: 3002 },
  { id: 'korecalendar', name: 'KoreCalendar', port: 3003 },
  { id: 'flatline', name: 'Flatline (KoreMonitor)', port: 3004 },
];

const secrets: Record<string, string> = {};
const clients = apps.map((a) => {
  const secret = randomBytes(32).toString('base64url');
  secrets[a.id] = secret;
  return {
    id: a.id,
    name: a.name,
    secretHash: createHash('sha256').update(secret).digest('hex'),
    redirectUris: [`http://localhost:${a.port}/auth/callback`],
    postLogoutRedirectUris: [`http://localhost:${a.port}/`],
  };
});
writeFileSync(file, JSON.stringify(clients, null, 2), { mode: 0o600 });
console.log(`Wrote ${file}. Client secrets (shown ONCE, store them in each app's env):\n`);
for (const [id, s] of Object.entries(secrets)) console.log(`  ${id}: ${s}`);
