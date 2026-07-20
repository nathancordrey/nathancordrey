// Smoke test for Session A: boots the game server in-process, joins two
// clients to the exact same room, drives one of them with intents, and
// asserts that snapshots flow and the humans receive opposite-team seats.

import http from 'node:http';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from 'colyseus.js';

import { MatchRoom } from '../src/MatchRoom.js';

const PORT = Number(process.env.SMOKE_PORT ?? 2599);

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
    console.log('server up');

    const clientA = new Client(`ws://localhost:${PORT}`);
    const clientB = new Client(`ws://localhost:${PORT}`);

    roomA = await clientA.joinOrCreate('match', { name: 'Nathan' });
    roomB = await clientB.joinById(roomA.roomId, { name: 'Rachel' });

    let teamA = '';
    let teamB = '';
    let snapshotsA = 0;
    let snapshotsB = 0;
    let enemySeenA = 0;
    let welcomeA: Record<string, unknown> | null = null;
    let welcomeB: Record<string, unknown> | null = null;

    roomA.onMessage('welcome', (data: Record<string, unknown>) => {
      welcomeA = data;
      teamA = typeof data.team === 'string' ? data.team : '';
      console.log('A welcome:', JSON.stringify(data));
    });
    roomB.onMessage('welcome', (data: Record<string, unknown>) => {
      welcomeB = data;
      teamB = typeof data.team === 'string' ? data.team : '';
      console.log('B welcome:', JSON.stringify(data));
    });
    roomA.onMessage('roster', (data: unknown) =>
      console.log('roster:', JSON.stringify(data))
    );
    roomB.onMessage('roster', () => {});
    roomA.onMessage('events', (events: unknown[]) => {
      for (const event of events) console.log('event:', JSON.stringify(event));
    });
    roomB.onMessage('events', () => {});

    // Register snapshot handlers before the ready handshake so the first
    // server-sent snapshot cannot race past the test.
    roomA.onMessage('snapshot', (snap: {
      tick: number;
      self: { id: string };
      allies: { id: string }[];
      visibleEnemies: { id: string }[];
    }) => {
      snapshotsA += 1;
      enemySeenA += snap.visibleEnemies.length;
      if (snapshotsA === 1) {
        console.log(
          'first snapshot A: tick',
          snap.tick,
          'self',
          snap.self.id,
          'allies',
          snap.allies.map((unit) => unit.id),
          'visibleEnemies',
          snap.visibleEnemies.length
        );
      }
    });
    roomB.onMessage('snapshot', (snap: { visibleEnemies: { id: string }[] }) => {
      snapshotsB += 1;
      if (snap.visibleEnemies.length > 0 && snapshotsB < 30) {
        console.log(
          'B sees enemies early:',
          JSON.stringify(snap.visibleEnemies.map((enemy) => enemy.id))
        );
      }
    });

    roomA.send('ready');
    roomB.send('ready');

    // Drive A forward (east) for 3 seconds.
    drive = setInterval(() => {
      roomA?.send('intent', { move: { x: 1, y: 0 } });
    }, 33);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    clearInterval(drive);
    drive = null;

    console.log('room IDs:', roomA.roomId, roomB.roomId);
    console.log('snapshots A:', snapshotsA, 'B:', snapshotsB);
    console.log('teams:', teamA, 'vs', teamB);
    console.log('enemy sightings for A (bot allies may spot):', enemySeenA);

    const pass =
      roomA.roomId === roomB.roomId &&
      welcomeA !== null &&
      welcomeB !== null &&
      teamA !== '' &&
      teamB !== '' &&
      teamA !== teamB &&
      snapshotsA > 60 &&
      snapshotsB > 60;

    console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL');
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
  console.error('SMOKE FAIL', error);
  process.exit(1);
});
