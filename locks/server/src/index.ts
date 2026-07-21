// Locks game service. Public Colyseus traffic runs matches; a localhost-only
// HTTP API lets the lobby provision and inspect disposable rooms.

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { matchMaker, Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';

import { MatchRoom } from './MatchRoom.js';

export type GameService = ReturnType<typeof createGameService>;

export function createGameService() {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  const httpServer = http.createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });
  gameServer.define('match', MatchRoom);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'locks-game', uptime: process.uptime() });
  });

  app.post('/internal/rooms', requireInternalSecret, async (_req, res) => {
    try {
      const room = await matchMaker.createRoom('match', { brokered: true });
      res.status(201).json({ roomId: room.roomId });
    } catch (error) {
      console.error('[locks-game] failed to create brokered room', error);
      res.status(503).json({ error: 'room creation failed' });
    }
  });

  app.get('/internal/rooms/:roomId', requireInternalSecret, async (req, res) => {
    try {
      const room = await matchMaker.getRoomById(req.params.roomId);
      if (room === undefined || room === null) {
        res.status(404).json({
          exists: false,
          roomId: req.params.roomId,
          joinable: false,
          humanCount: 0,
          maxClients: 0,
        });
        return;
      }

      const cached = room as unknown as Record<string, unknown>;
      const clients = finiteInteger(cached.clients);
      const maxClients = finiteInteger(cached.maxClients);
      const locked = cached.locked === true;
      res.json({
        exists: true,
        roomId: req.params.roomId,
        joinable: !locked && clients < maxClients,
        humanCount: clients,
        maxClients,
      });
    } catch {
      res.status(404).json({
        exists: false,
        roomId: req.params.roomId,
        joinable: false,
        humanCount: 0,
        maxClients: 0,
      });
    }
  });

  return {
    app,
    httpServer,
    gameServer,
    async start(port: number) {
      await gameServer.listen(port);
      console.log(`[locks-game] listening on :${port}`);
    },
    async stop() {
      await gameServer.gracefullyShutdown(false);
    },
  };
}

async function startMain() {
  const port = parsePort(process.env.PORT ?? '2567');
  const service = createGameService();
  await service.start(port);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMain().catch((error: unknown) => {
    console.error('[locks-game] failed to start', error);
    process.exitCode = 1;
  });
}

function requireInternalSecret(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const expected =
    process.env.SERVICE_SHARED_SECRET ??
    (process.env.NODE_ENV === 'production' ? '' : 'locks-dev-secret-change-me');
  const supplied = req.header('x-locks-secret') ?? '';
  if (expected.length === 0 || !safeEqual(supplied, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function finiteInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}
