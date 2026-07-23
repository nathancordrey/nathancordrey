// Hidden developer-WASD smoke test. Boots the authoritative room, joins two
// clients, drives one human with the legacy sanitized intent protocol, and
// confirms snapshots continue while the unit actually moves.

import http from 'node:http';
import express from 'express';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from 'colyseus.js';

import { MatchRoom } from '../src/MatchRoom.js';

const PORT = Number(process.env.DEV_WASD_SMOKE_PORT ?? 2600);

async function main() {
  const app = express();
  const httpServer = http.createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });
  gameServer.define('match', MatchRoom);

  let roomA: Awaited<ReturnType<Client['joinOrCreate']>> | null = null;
  let roomB: Awaited<ReturnType<Client['joinById']>> | null = null;
  let drive: ReturnType<typeof setInterval> | null = null;
  let exitCode = 1;

  try {
    await gameServer.listen(PORT);
    console.log('dev-WASD server up');

    const clientA = new Client(`ws://localhost:${PORT}`);
    const clientB = new Client(`ws://localhost:${PORT}`);

    roomA = await clientA.joinOrCreate('match', { name: 'Nathan' });
    roomB = await clientB.joinById(roomA.roomId, { name: 'Rachel' });

    let snapshotsA = 0;
    let snapshotsB = 0;
    let initialX: number | null = null;
    let finalX: number | null = null;

    roomA.onMessage('welcome', () => {});
    roomB.onMessage('welcome', () => {});
    roomA.onMessage('roster', () => {});
    roomB.onMessage('roster', () => {});
    roomA.onMessage('events', () => {});
    roomB.onMessage('events', () => {});
    roomA.onMessage('command-result', () => {});
    roomB.onMessage('command-result', () => {});

    roomA.onMessage('snapshot', (snap: { self: { x: number } }) => {
      snapshotsA += 1;
      if (initialX === null) initialX = snap.self.x;
      finalX = snap.self.x;
    });
    roomB.onMessage('snapshot', () => {
      snapshotsB += 1;
    });

    roomA.send('ready');
    roomB.send('ready');

    // The production client sends these only when `?controls=wasd` is active.
    drive = setInterval(() => {
      roomA?.send('intent', { move: { x: 1, y: 0 } });
    }, 33);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    clearInterval(drive);
    drive = null;

    const displacement =
      initialX === null || finalX === null ? 0 : finalX - initialX;

    console.log('snapshots A:', snapshotsA, 'B:', snapshotsB);
    console.log('dev-WASD east displacement:', displacement.toFixed(2));

    const pass =
      roomA.roomId === roomB.roomId &&
      snapshotsA > 60 &&
      snapshotsB > 60 &&
      displacement > 25;

    console.log(pass ? 'DEV WASD SMOKE PASS' : 'DEV WASD SMOKE FAIL');
    exitCode = pass ? 0 : 1;
  } finally {
    if (drive !== null) clearInterval(drive);
    if (roomA !== null) await roomA.leave().catch(() => {});
    if (roomB !== null) await roomB.leave().catch(() => {});
    await gameServer.gracefullyShutdown(false).catch(() => {});
  }

  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error('DEV WASD SMOKE FAIL', error);
  process.exit(1);
});
