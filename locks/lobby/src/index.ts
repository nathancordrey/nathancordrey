// Locks lobby service. Slice 3 adds the quick-play broker: validate a guest,
// prefer the most-populated joinable match, create one when needed, and issue
// a short-lived signed token for that exact Colyseus room.

import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';

import { createGameApi } from './gameApi.js';
import type { GameApi } from './gameApi.js';
import { createJoinToken } from './joinToken.js';
import { createStore } from './store.js';
import type { Store } from './store.js';

const DEFAULT_MAX_PLAYERS = 6;
const CLAIM_TTL_MS = 65_000;

type LobbyConfig = {
  store?: Store;
  gameApi?: GameApi;
  sharedSecret?: string;
  joinTokenSecret?: string;
  gamePublicUrl?: string;
  maxPlayers?: number;
  joinTokenTtlSeconds?: number;
};

type LifecycleEvent =
  | { type: 'room_created'; roomId: string; humanCount: number }
  | { type: 'player_joined'; roomId: string; humanCount: number }
  | { type: 'player_left'; roomId: string; humanCount: number }
  | {
      type: 'match_ended';
      roomId: string;
      humanCount: number;
      result: 'red' | 'blue' | 'draw';
      scoreRed: number;
      scoreBlue: number;
    }
  | { type: 'room_disposed'; roomId: string; humanCount: number };

export async function buildLobbyApp(overrides: LobbyConfig = {}) {
  const sharedSecret =
    overrides.sharedSecret ?? process.env.SERVICE_SHARED_SECRET ?? devSecret();
  const joinTokenSecret =
    overrides.joinTokenSecret ?? process.env.JOIN_TOKEN_SECRET ?? sharedSecret;
  const gamePublicUrl =
    overrides.gamePublicUrl ??
    process.env.GAME_PUBLIC_URL ??
    'ws://localhost:2567';
  const maxPlayers = overrides.maxPlayers ?? DEFAULT_MAX_PLAYERS;
  const joinTokenTtlSeconds = overrides.joinTokenTtlSeconds ?? 60;
  const store = overrides.store ?? createStore();
  const gameApi =
    overrides.gameApi ??
    createGameApi({
      baseUrl: process.env.GAME_INTERNAL_URL ?? 'http://127.0.0.1:2567',
      sharedSecret,
    });

  if (process.env.NODE_ENV === 'production' && sharedSecret === 'locks-dev-secret-change-me') {
    throw new Error('SERVICE_SHARED_SECRET must be set in production');
  }
  if (joinTokenSecret.length < 16) {
    throw new Error('JOIN_TOKEN_SECRET must be at least 16 characters');
  }

  await store.init();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  // Tokens issued but not yet consumed count against a room briefly, keeping
  // simultaneous Play requests from overfilling the same match.
  const pendingClaims = new Map<string, number[]>();
  let brokerTail: Promise<void> = Promise.resolve();

  const withBrokerLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = brokerTail;
    let release!: () => void;
    brokerTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const cleanClaims = (roomId?: string) => {
    const now = Date.now();
    const ids = roomId === undefined ? [...pendingClaims.keys()] : [roomId];
    for (const id of ids) {
      const live = (pendingClaims.get(id) ?? []).filter((expiresAt) => expiresAt > now);
      if (live.length === 0) pendingClaims.delete(id);
      else pendingClaims.set(id, live);
    }
  };

  const releaseClaim = (roomId: string) => {
    cleanClaims(roomId);
    const claims = pendingClaims.get(roomId);
    if (claims === undefined || claims.length === 0) return;
    claims.shift();
    if (claims.length === 0) pendingClaims.delete(roomId);
  };

  const claimRoom = async (): Promise<string> =>
    withBrokerLock(async () => {
      cleanClaims();
      const candidates = await store.listJoinableGames();

      for (const candidate of candidates) {
        try {
          const status = await gameApi.roomStatus(candidate.roomId);
          if (!status.exists) {
            await store.updateGame(candidate.roomId, { status: 'finished' });
            continue;
          }

          await store.updateGame(candidate.roomId, {
            status: 'live',
            playerCount: status.humanCount,
          });

          const pending = pendingClaims.get(candidate.roomId)?.length ?? 0;
          const capacity = Math.min(maxPlayers, status.maxClients);
          if (!status.joinable || status.humanCount + pending >= capacity) continue;

          pendingClaims.set(candidate.roomId, [
            ...(pendingClaims.get(candidate.roomId) ?? []),
            Date.now() + CLAIM_TTL_MS,
          ]);
          return candidate.roomId;
        } catch (error) {
          app.log.warn({ error, roomId: candidate.roomId }, 'stale game candidate');
          await store.updateGame(candidate.roomId, { status: 'finished' });
        }
      }

      const created = await gameApi.createRoom();
      await store.upsertGame(created.roomId, 'live', 0);
      pendingClaims.set(created.roomId, [Date.now() + CLAIM_TTL_MS]);
      return created.roomId;
    });

  app.get('/health', async () => {
    const db = await store.health();
    return { ok: db.ok, service: 'locks-lobby', store: store.kind, detail: db.detail };
  });

  // Guest session: type a name, get a revocable lobby token. No account.
  app.post<{ Body: { name?: string } }>('/guest', async (request, reply) => {
    const raw = normalizeGuestName(request.body?.name ?? '');
    if (raw.length === 0) {
      return reply.code(400).send({ error: 'name required' });
    }
    const name = `~${raw.slice(0, 15)}`;
    const session = await store.createGuest(name);
    return {
      token: session.token,
      name: session.name,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  });

  app.get<{ Querystring: { token?: string } }>('/session', async (request, reply) => {
    const token = request.query?.token ?? '';
    const session = await store.getSession(token);
    if (session === null) return reply.code(404).send({ error: 'unknown session' });
    return { name: session.name, expiresAt: new Date(session.expiresAt).toISOString() };
  });

  app.post<{ Body: { sessionToken?: string } }>('/play', async (request, reply) => {
    const sessionToken =
      bearerToken(request.headers.authorization) ?? request.body?.sessionToken ?? '';
    const session = await store.getSession(sessionToken);
    if (session === null) {
      return reply.code(401).send({ error: 'invalid or expired guest session' });
    }

    try {
      const roomId = await claimRoom();
      const signed = createJoinToken(
        joinTokenSecret,
        roomId,
        session.name,
        joinTokenTtlSeconds
      );
      return {
        roomId,
        joinToken: signed.token,
        expiresAt: new Date(signed.expiresAt * 1_000).toISOString(),
        gameServerUrl: gamePublicUrl,
      };
    } catch (error) {
      request.log.error({ error }, 'quick-play broker failed');
      return reply.code(503).send({ error: 'no game server available' });
    }
  });

  app.post<{ Body: LifecycleEvent }>('/internal/game-events', async (request, reply) => {
    const supplied = request.headers['x-locks-secret'];
    if (typeof supplied !== 'string' || !safeEqual(supplied, sharedSecret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const event = request.body;
    if (!validLifecycleEvent(event)) {
      return reply.code(400).send({ error: 'invalid lifecycle event' });
    }

    switch (event.type) {
      case 'room_created':
        // Preserve a later terminal status if a retried create report arrives
        // out of order. updateGame creates a live row when none exists.
        await store.updateGame(event.roomId, { playerCount: event.humanCount });
        break;
      case 'player_joined':
        releaseClaim(event.roomId);
        await store.updateGame(event.roomId, { playerCount: event.humanCount });
        break;
      case 'player_left':
        await store.updateGame(event.roomId, {
          playerCount: event.humanCount,
        });
        break;
      case 'match_ended':
        pendingClaims.delete(event.roomId);
        await store.recordMatchEnd(event.roomId, {
          result: event.result,
          scoreRed: event.scoreRed,
          scoreBlue: event.scoreBlue,
        });
        break;
      case 'room_disposed':
        pendingClaims.delete(event.roomId);
        await store.updateGame(event.roomId, {
          status: 'finished',
          playerCount: event.humanCount,
        });
        break;
    }

    return { ok: true };
  });

  app.addHook('onClose', async () => {
    await store.close();
  });

  return { app, store };
}

async function start() {
  const port = parsePort(process.env.LOBBY_PORT ?? '2568');
  const { app, store } = await buildLobbyApp();
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`[locks-lobby] listening on :${port} (store: ${store.kind})`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error: unknown) => {
    console.error('[locks-lobby] failed to start', error);
    process.exitCode = 1;
  });
}

function devSecret(): string {
  return process.env.NODE_ENV === 'production'
    ? ''
    : 'locks-dev-secret-change-me';
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid LOBBY_PORT value: ${value}`);
  }
  return port;
}

function normalizeGuestName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
}

function bearerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validLifecycleEvent(value: unknown): value is LifecycleEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (typeof value.roomId !== 'string' || value.roomId.length < 1) return false;
  if (!validCount(value.humanCount)) return false;

  if (value.type === 'match_ended') {
    return (
      (value.result === 'red' || value.result === 'blue' || value.result === 'draw') &&
      validCount(value.scoreRed) &&
      validCount(value.scoreBlue)
    );
  }
  return (
    value.type === 'room_created' ||
    value.type === 'player_joined' ||
    value.type === 'player_left' ||
    value.type === 'room_disposed'
  );
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

