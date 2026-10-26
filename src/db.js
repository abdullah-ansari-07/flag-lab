'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Three tables, each with one job:
//   sessions      - lifecycle of a lab session (and whether its container is gone)
//   flags         - one row per (session, flag type): the HMAC of the expected flag
//   flag_attempts - append-only audit trail of every submission
// flag_attempts deliberately has NO foreign key: attempts against unknown or
// malformed session IDs must still be logged.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  user_id      INTEGER,                -- owner (NULL only for sessions created outside the HTTP API)
  status       TEXT NOT NULL CHECK (status IN ('provisioning','active','expired','terminated','failed')),
  container_id TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  ended_at     TEXT,
  cleanup_done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS flags (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  flag_type  TEXT NOT NULL CHECK (flag_type IN ('user','root')),
  flag_hash  TEXT NOT NULL,            -- HMAC-SHA256 hex; blanked ('') on expiry
  status     TEXT NOT NULL CHECK (status IN ('active','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  solved_at  TEXT,
  expired_at TEXT,
  PRIMARY KEY (session_id, flag_type)
);

CREATE TABLE IF NOT EXISTS flag_attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  flag_type      TEXT,
  submitted_hash TEXT NOT NULL,        -- HMAC of the submission, never the plaintext
  result         TEXT NOT NULL,
  source_ip      TEXT,
  user_id        INTEGER,              -- who submitted (NULL if unauthenticated/internal)
  timestamp      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_session ON flag_attempts(session_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,   -- stored lowercase
  password_hash TEXT NOT NULL,          -- scrypt$N$r$p$salt$hash, never the password
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_sessions (
  token_hash TEXT PRIMARY KEY,          -- SHA-256 of the cookie token; the token itself is never stored
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

// Databases created before user accounts existed lack these columns.
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureColumn(db, 'sessions', 'user_id', 'INTEGER');
  ensureColumn(db, 'flag_attempts', 'user_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at)');
  return db;
}

module.exports = { openDb };
