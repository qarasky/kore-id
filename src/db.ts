import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

export type Db = DatabaseSync;

const USERS_TABLE = (name: string) => `
    CREATE TABLE IF NOT EXISTS ${name} (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    )`;

type ColInfo = { name: string; notnull: number };
const columns = (db: Db, table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColInfo[];
const addColumn = (db: Db, table: string, col: string, def: string) => {
  if (!columns(db, table).some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};

export function openDb(dataDir: string): Db {
  const file = dataDir === ':memory:' ? ':memory:' : (mkdirSync(dataDir, { recursive: true }), `${dataDir}/auth.db`);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(USERS_TABLE('users'));

  // Migration: pre-admin DBs had `password_hash NOT NULL` and no role/last_login_at. SQLite can't relax NOT NULL
  // in place, so rebuild the table (the documented 12-step procedure).
  const userCols = columns(db, 'users');
  if (userCols.find((c) => c.name === 'password_hash')?.notnull || !userCols.some((c) => c.name === 'role')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec('DROP TABLE IF EXISTS users_new');
      db.exec(USERS_TABLE('users_new'));
      db.exec('INSERT INTO users_new (id, email, name, password_hash, disabled, created_at) SELECT id, email, name, password_hash, disabled, created_at FROM users');
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    db.exec('PRAGMA foreign_keys = ON');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_apps (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      app TEXT NOT NULL,
      PRIMARY KEY (user_id, app)
    );
    CREATE TABLE IF NOT EXISTS setup_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_clients (
      sid TEXT NOT NULL,
      client_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (sid, client_id)
    );
    CREATE TABLE IF NOT EXISTS auth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scope TEXT NOT NULL,
      nonce TEXT,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      family TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS revoked_jti (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      actor_id TEXT,
      actor_email TEXT,
      action TEXT NOT NULL,
      target_id TEXT,
      target TEXT,
      ip TEXT,
      user_agent TEXT,
      detail TEXT
    );
  `);

  // sessions: public opaque `sid` (≠ cookie value), auth_time, client metadata, explicit end marker.
  addColumn(db, 'sessions', 'sid', 'TEXT');
  addColumn(db, 'sessions', 'auth_time', 'INTEGER');
  addColumn(db, 'sessions', 'last_seen_at', 'INTEGER');
  addColumn(db, 'sessions', 'ip', 'TEXT');
  addColumn(db, 'sessions', 'user_agent', 'TEXT');
  addColumn(db, 'sessions', 'ended_at', 'INTEGER');
  db.exec("UPDATE sessions SET sid = lower(hex(randomblob(16))) WHERE sid IS NULL");
  db.exec('UPDATE sessions SET auth_time = created_at WHERE auth_time IS NULL');
  addColumn(db, 'auth_codes', 'sid', 'TEXT');
  addColumn(db, 'auth_codes', 'auth_time', 'INTEGER');
  addColumn(db, 'refresh_tokens', 'sid', 'TEXT');
  addColumn(db, 'refresh_tokens', 'auth_time', 'INTEGER');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_sid ON sessions(sid);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS refresh_family ON refresh_tokens(family);
    CREATE INDEX IF NOT EXISTS refresh_user ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS refresh_sid ON refresh_tokens(sid);
    CREATE INDEX IF NOT EXISTS setup_user ON setup_tokens(user_id);
    CREATE INDEX IF NOT EXISTS audit_actor ON audit_log(actor_id);
    CREATE INDEX IF NOT EXISTS audit_target ON audit_log(target_id);
  `);
  return db;
}

/** Purge rows that can no longer matter. Ended sessions are kept until their natural expiry so introspection can
 * still report tokens from them as inactive. */
export function purgeExpired(db: Db, t = Math.floor(Date.now() / 1000)) {
  db.prepare('DELETE FROM session_clients WHERE sid IN (SELECT sid FROM sessions WHERE expires_at < ?) AND sid NOT IN (SELECT sid FROM refresh_tokens WHERE sid IS NOT NULL AND revoked = 0 AND expires_at >= ?)').run(t, t);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM setup_tokens WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM revoked_jti WHERE expires_at < ?').run(t);
}

export type Role = 'admin' | 'user';
export interface UserRow {
  id: string; email: string; name: string; password_hash: string | null; role: Role; disabled: number;
  created_at: number; last_login_at: number | null;
}
export interface SessionRow {
  id_hash: string; sid: string; user_id: string; expires_at: number; created_at: number; auth_time: number;
  last_seen_at: number | null; ip: string | null; user_agent: string | null; ended_at: number | null;
}
