/* Skema SQLite per room (satu Durable Object = satu room). Idempotent. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS room (
    k INTEGER PRIMARY KEY CHECK (k = 1),
    room_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL,
    pw_salt TEXT, pw_hash TEXT, invite_key TEXT NOT NULL,
    max_participants INTEGER NOT NULL, chat_enabled INTEGER NOT NULL,
    host_id TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, end_reason TEXT,
    empty_since INTEGER, host_away_since INTEGER, media TEXT,
    p_playing INTEGER NOT NULL DEFAULT 0, p_pos REAL NOT NULL DEFAULT 0, p_rate REAL NOT NULL DEFAULT 1,
    p_at INTEGER NOT NULL, p_ver INTEGER NOT NULL DEFAULT 0, alarm_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    user_id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '',
    joined_at INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL,
    muted_until INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, last_react INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS tickets (
    ticket TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pause_req (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    seek_to REAL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, resolved_at INTEGER
  )`,
];
