// Locks game service entrypoint. Owns nothing persistent: spawns match
// rooms, runs the shared sim, and (later) validates lobby join tokens and
// reports results back.

import http from 'node:http';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';

import { MatchRoom } from './MatchRoom.js';

const requestedPort = Number(process.env.PORT ?? 2567);
if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT ?? ''}`);
}
const port = requestedPort;

const app = express();
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'locks-game', uptime: process.uptime() });
});

const httpServer = http.createServer(app);

export const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('match', MatchRoom);

async function start() {
  await gameServer.listen(port);
  console.log(`[locks-game] listening on :${port}`);
}

start().catch((error: unknown) => {
  console.error('[locks-game] failed to start', error);
  process.exitCode = 1;
});
