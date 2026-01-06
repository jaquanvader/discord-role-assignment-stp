const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || "bot.sqlite";
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  discord_user_id TEXT PRIMARY KEY,
  trial_used INTEGER DEFAULT 0,
  trial_expires_at INTEGER,
  gate_role_id TEXT,
  paid INTEGER DEFAULT 0,
  last_join_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_trial_expires ON users(trial_expires_at);
`);

module.exports = db;

