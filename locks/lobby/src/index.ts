// Locks lobby service (Slice 2 skeleton). Owns identity, and later chat,
// presence, matchmaking, clans, and stats. For now: guest sessions + health,
// on Fastify, backed by Postgres or an in-memory fallback.

import Fastify from 'fastify';
import cors from '@fastify/cors';

import { createStore } from './store.js';

const port = Number(process.env.LOBBY_PORT ?? 2568);
const store = createStore();

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get('/health', async () => {
  const db = await store.health();
  return { ok: db.ok, service: 'locks-lobby', store: store.kind, detail: db.detail };
});

// Guest session: type a name, get a token. No account, no password.
app.post<{ Body: { name?: string } }>('/guest', async (request, reply) => {
  const raw = (request.body?.name ?? '').trim();
  if (raw.length === 0) {
    return reply.code(400).send({ error: 'name required' });
  }
  // Guests are decorated so they can't impersonate a registered [TAG]Name.
  const name = `~${raw.slice(0, 15)}`;
  const session = await store.createGuest(name);
  return { token: session.token, name: session.name };
});

// Validate a session token (used later by the game-join handoff).
app.get<{ Querystring: { token?: string } }>('/session', async (request, reply) => {
  const token = request.query?.token ?? '';
  const session = await store.getSession(token);
  if (session === null) return reply.code(404).send({ error: 'unknown session' });
  return { name: session.name };
});

await store.init();
await app.listen({ port, host: '0.0.0.0' });
app.log.info(`[locks-lobby] listening on :${port} (store: ${store.kind})`);
