// Data layer. Uses Postgres when DATABASE_URL is set, otherwise an in-memory
// store so the service runs (and the deploy path can be tested) before the
// database exists. The interface is identical either way; Slice 5 (accounts)
// leans on the same store.

import pg from 'pg';
import { randomUUID } from 'node:crypto';

export type GuestSession = {
  token: string;
  name: string;
  createdAt: number;
};

export interface Store {
  readonly kind: 'postgres' | 'memory';
  init(): Promise<void>;
  createGuest(name: string): Promise<GuestSession>;
  getSession(token: string): Promise<GuestSession | null>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

// --- In-memory (no DB) ----------------------------------------------------

class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private sessions = new Map<string, GuestSession>();

  async init() {}

  async createGuest(name: string): Promise<GuestSession> {
    const session: GuestSession = { token: randomUUID(), name, createdAt: Date.now() };
    this.sessions.set(session.token, session);
    return session;
  }

  async getSession(token: string): Promise<GuestSession | null> {
    return this.sessions.get(token) ?? null;
  }

  async health() {
    return { ok: true, detail: `memory (${this.sessions.size} sessions)` };
  }
}

// --- Postgres -------------------------------------------------------------

class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init() {
    // Sessions table is enough for Slice 2; full schema lands in migrate.ts.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER,
        guest_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ
      )
    `);
  }

  async createGuest(name: string): Promise<GuestSession> {
    const token = randomUUID();
    await this.pool.query(
      `INSERT INTO sessions (token, guest_name) VALUES ($1, $2)`,
      [token, name]
    );
    return { token, name, createdAt: Date.now() };
  }

  async getSession(token: string): Promise<GuestSession | null> {
    const result = await this.pool.query(
      `SELECT token, guest_name, created_at FROM sessions WHERE token = $1`,
      [token]
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      token: row.token,
      name: row.guest_name ?? 'Player',
      createdAt: new Date(row.created_at).getTime(),
    };
  }

  async health() {
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, detail: 'postgres connected' };
    } catch (error) {
      return { ok: false, detail: `postgres error: ${(error as Error).message}` };
    }
  }
}

export function createStore(): Store {
  const url = process.env.DATABASE_URL;
  if (url !== undefined && url !== '') return new PostgresStore(url);
  return new MemoryStore();
}
