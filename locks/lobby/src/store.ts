// Lobby data layer. Postgres is the production source of truth; the memory
// implementation keeps local development and smoke tests frictionless.

import pg from 'pg';
import { randomUUID } from 'node:crypto';

export type GuestSession = {
  token: string;
  name: string;
  createdAt: number;
  expiresAt: number;
};

export type GameStatus = 'creating' | 'open' | 'live' | 'finished';

export type LobbyGame = {
  roomId: string;
  status: GameStatus;
  playerCount: number;
  createdAt: number;
};

export type MatchSummary = {
  result: 'red' | 'blue' | 'draw';
  scoreRed: number;
  scoreBlue: number;
};

export interface Store {
  readonly kind: 'postgres' | 'memory';
  init(): Promise<void>;
  createGuest(name: string): Promise<GuestSession>;
  getSession(token: string): Promise<GuestSession | null>;
  upsertGame(roomId: string, status: GameStatus, playerCount: number): Promise<void>;
  listJoinableGames(): Promise<LobbyGame[]>;
  updateGame(
    roomId: string,
    update: { status?: GameStatus; playerCount?: number }
  ): Promise<void>;
  recordMatchEnd(roomId: string, summary: MatchSummary): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}

const GUEST_TTL_MS = 24 * 60 * 60 * 1_000;

// --- In-memory ------------------------------------------------------------

class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private sessions = new Map<string, GuestSession>();
  private games = new Map<string, LobbyGame>();
  private results = new Map<string, MatchSummary>();

  async init() {}

  async createGuest(name: string): Promise<GuestSession> {
    const now = Date.now();
    const session: GuestSession = {
      token: randomUUID(),
      name,
      createdAt: now,
      expiresAt: now + GUEST_TTL_MS,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  async getSession(token: string): Promise<GuestSession | null> {
    const session = this.sessions.get(token) ?? null;
    if (session !== null && session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  async upsertGame(roomId: string, status: GameStatus, playerCount: number) {
    const existing = this.games.get(roomId);
    this.games.set(roomId, {
      roomId,
      status,
      playerCount: sanitizeCount(playerCount),
      createdAt: existing?.createdAt ?? Date.now(),
    });
  }

  async listJoinableGames(): Promise<LobbyGame[]> {
    return [...this.games.values()]
      .filter((game) => game.status === 'open' || game.status === 'live')
      .sort((a, b) => b.playerCount - a.playerCount || a.createdAt - b.createdAt);
  }

  async updateGame(
    roomId: string,
    update: { status?: GameStatus; playerCount?: number }
  ) {
    const existing = this.games.get(roomId);
    if (existing === undefined) {
      await this.upsertGame(
        roomId,
        update.status ?? 'live',
        update.playerCount ?? 0
      );
      return;
    }
    this.games.set(roomId, {
      ...existing,
      status: update.status ?? existing.status,
      playerCount:
        update.playerCount === undefined
          ? existing.playerCount
          : sanitizeCount(update.playerCount),
    });
  }

  async recordMatchEnd(roomId: string, summary: MatchSummary) {
    this.results.set(roomId, summary);
    await this.updateGame(roomId, { status: 'finished' });
  }

  async health() {
    return {
      ok: true,
      detail: `memory (${this.sessions.size} sessions, ${this.games.size} games)`,
    };
  }

  async close() {}
}

// --- Postgres -------------------------------------------------------------

class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init() {
    // Keep startup safe even if migrate has not yet been rerun after pulling
    // Slice 3. The full schema remains in scripts/migrate.ts.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER,
        guest_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        room_id TEXT NOT NULL,
        host_name TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        map TEXT,
        player_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_games_room_id_unique ON games(room_id)`
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS match_results (
        id SERIAL PRIMARY KEY,
        game_id INTEGER REFERENCES games(id),
        winner TEXT,
        score_red INTEGER NOT NULL DEFAULT 0,
        score_blue INTEGER NOT NULL DEFAULT 0,
        ended_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_match_results_game_unique ON match_results(game_id)`
    );
  }

  async createGuest(name: string): Promise<GuestSession> {
    const token = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + GUEST_TTL_MS;
    await this.pool.query(
      `INSERT INTO sessions (token, guest_name, expires_at) VALUES ($1, $2, $3)`,
      [token, name, new Date(expiresAt)]
    );
    return { token, name, createdAt, expiresAt };
  }

  async getSession(token: string): Promise<GuestSession | null> {
    const result = await this.pool.query(
      `SELECT token, guest_name, created_at, expires_at
         FROM sessions
        WHERE token = $1
          AND (expires_at IS NULL OR expires_at > now())`,
      [token]
    );
    if ((result.rowCount ?? 0) === 0) return null;
    const row = result.rows[0];
    return {
      token: row.token,
      name: row.guest_name ?? 'Player',
      createdAt: new Date(row.created_at).getTime(),
      expiresAt:
        row.expires_at === null
          ? Date.now() + GUEST_TTL_MS
          : new Date(row.expires_at).getTime(),
    };
  }

  async upsertGame(roomId: string, status: GameStatus, playerCount: number) {
    await this.pool.query(
      `INSERT INTO games (room_id, status, player_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_id) DO UPDATE
         SET status = EXCLUDED.status,
             player_count = EXCLUDED.player_count`,
      [roomId, status, sanitizeCount(playerCount)]
    );
  }

  async listJoinableGames(): Promise<LobbyGame[]> {
    const result = await this.pool.query(
      `SELECT room_id, status, player_count, created_at
         FROM games
        WHERE status IN ('open', 'live')
        ORDER BY player_count DESC, created_at ASC`
    );
    return result.rows.map((row) => ({
      roomId: row.room_id,
      status: row.status as GameStatus,
      playerCount: Number(row.player_count),
      createdAt: new Date(row.created_at).getTime(),
    }));
  }

  async updateGame(
    roomId: string,
    update: { status?: GameStatus; playerCount?: number }
  ) {
    const status = update.status ?? null;
    const playerCount =
      update.playerCount === undefined ? null : sanitizeCount(update.playerCount);
    const result = await this.pool.query(
      `UPDATE games
          SET status = COALESCE($2, status),
              player_count = COALESCE($3, player_count)
        WHERE room_id = $1`,
      [roomId, status, playerCount]
    );
    if ((result.rowCount ?? 0) === 0) {
      await this.upsertGame(roomId, update.status ?? 'live', playerCount ?? 0);
    }
  }

  async recordMatchEnd(roomId: string, summary: MatchSummary) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const game = await client.query(
        `INSERT INTO games (room_id, status, player_count)
         VALUES ($1, 'finished', 0)
         ON CONFLICT (room_id) DO UPDATE SET status = 'finished'
         RETURNING id`,
        [roomId]
      );
      const gameId = game.rows[0].id;
      await client.query(
        `INSERT INTO match_results (game_id, winner, score_red, score_blue)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (game_id) DO UPDATE
           SET winner = EXCLUDED.winner,
               score_red = EXCLUDED.score_red,
               score_blue = EXCLUDED.score_blue,
               ended_at = now()`,
        [gameId, summary.result, summary.scoreRed, summary.scoreBlue]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async health() {
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, detail: 'postgres connected' };
    } catch (error) {
      return { ok: false, detail: `postgres error: ${(error as Error).message}` };
    }
  }

  async close() {
    await this.pool.end();
  }
}

export function createStore(connectionString: string | undefined = process.env.DATABASE_URL): Store {
  if (connectionString !== undefined && connectionString !== '') {
    return new PostgresStore(connectionString);
  }
  return new MemoryStore();
}

function sanitizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
