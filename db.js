// db.js - conexion y schema usando el modulo built-in node:sqlite (Node >=22.5)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'quiniela.db');
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
// WAL mejora performance; si el FS no soporta shared-memory caemos al journal por defecto.
try { db.exec('PRAGMA journal_mode = WAL'); } catch (e) { /* fallback */ }
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round TEXT NOT NULL,
    match_date TEXT NOT NULL,
    match_time TEXT,
    team1 TEXT NOT NULL,
    team2 TEXT NOT NULL,
    grp TEXT,
    ground TEXT,
    goals1 INTEGER,
    goals2 INTEGER,
    finished INTEGER NOT NULL DEFAULT 0,
    UNIQUE(round, match_date, team1, team2)
  );

  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    match_id INTEGER NOT NULL,
    pred_goals1 INTEGER NOT NULL,
    pred_goals2 INTEGER NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, match_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_pred_user ON predictions(user_id);
  CREATE INDEX IF NOT EXISTS idx_pred_match ON predictions(match_id);
  CREATE INDEX IF NOT EXISTS idx_match_round ON matches(round);

  CREATE TABLE IF NOT EXISTS sessions (
    sid  TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
`);

// Helper para transacciones (node:sqlite no tiene db.transaction)
db.runInTx = function (fn) {
  this.exec('BEGIN');
  try { fn(); this.exec('COMMIT'); }
  catch (e) { this.exec('ROLLBACK'); throw e; }
};

module.exports = db;
