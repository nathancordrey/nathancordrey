// Schema migration. Idempotent — safe to run repeatedly. Creates the tables
// the sliced roadmap needs; later slices (accounts, clans, stats) fill them.
// Run with DATABASE_URL set:  npm run migrate

import pg from 'pg';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('DATABASE_URL not set — nothing to migrate (memory store needs no schema).');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });

const statements = [
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     username TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     clan_id INTEGER,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER REFERENCES users(id),
     guest_name TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS clans (
     id SERIAL PRIMARY KEY,
     tag TEXT UNIQUE NOT NULL,
     name TEXT NOT NULL,
     founder_id INTEGER REFERENCES users(id),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id SERIAL PRIMARY KEY,
     channel TEXT NOT NULL,
     user_id INTEGER,
     author_name TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS games (
     id SERIAL PRIMARY KEY,
     room_id TEXT NOT NULL,
     host_name TEXT,
     status TEXT NOT NULL DEFAULT 'open',
     map TEXT,
     player_count INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS match_results (
     id SERIAL PRIMARY KEY,
     game_id INTEGER REFERENCES games(id),
     winner TEXT,
     score_red INTEGER NOT NULL DEFAULT 0,
     score_blue INTEGER NOT NULL DEFAULT 0,
     ended_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Stats aggregate only over rows with a real user_id; guests carry a name.
  `CREATE TABLE IF NOT EXISTS match_players (
     id SERIAL PRIMARY KEY,
     match_id INTEGER REFERENCES match_results(id),
     user_id INTEGER REFERENCES users(id),
     guest_name TEXT,
     team TEXT NOT NULL,
     kills INTEGER NOT NULL DEFAULT 0,
     deaths INTEGER NOT NULL DEFAULT 0,
     captures INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id)`,
];

async function main() {
  for (const sql of statements) {
    await pool.query(sql);
    console.log('ok:', sql.split('\n')[0].trim());
  }
  console.log('migration complete');
  await pool.end();
}

main().catch((error) => {
  console.error('migration failed:', error);
  process.exit(1);
});
