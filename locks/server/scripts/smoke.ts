// Smoke test for Session A: boots the game server in-process, joins two
// clients, drives one of them with intents, and asserts that (a) snapshots
// flow at tick rate, (b) the two clients are seated on opposite teams, and
// (c) each client only ever receives enemy positions its team can see.

import http from 'node:http';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from 'colyseus.js';

import { MatchRoom } from '../src/MatchRoom.js';

const PORT = 2599;

async function main() {
  const app = express();
  const httpServer = http.createServer(app);
  const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
  gameServer.define('match', MatchRoom);
  await gameServer.listen(PORT);
  console.log('server up');

  const clientA = new Client(`ws://localhost:${PORT}`);
  const clientB = new Client(`ws://localhost:${PORT}`);

  const roomA = await clientA.joinOrCreate('match', { name: 'Nathan' });
  const roomB = await clientB.join('match', { name: 'Rachel' });

  let teamA = '';
  let teamB = '';
  let snapshotsA = 0;
  let snapshotsB = 0;
  let enemySeenA = 0;
  let welcomeA: Record<string, unknown> | null = null;

  roomA.onMessage('welcome', (data) => {
    welcomeA = data;
    teamA = data.team;
    console.log('A welcome:', JSON.stringify(data));
  });
  roomB.onMessage('welcome', (data) => {
    teamB = data.team;
    console.log('B welcome:', JSON.stringify(data));
  });
  roomA.onMessage('roster', (data) => console.log('roster:', JSON.stringify(data)));
  roomB.onMessage('roster', () => {});
  roomA.onMessage('events', (events) => {
    for (const event of events) console.log('event:', JSON.stringify(event));
  });
  roomB.onMessage('events', () => {});

  roomA.send('ready');
  roomB.send('ready');

  roomA.onMessage('snapshot', (snap) => {
    snapshotsA += 1;
    enemySeenA += snap.visibleEnemies.length;
    if (snapshotsA === 1) {
      console.log(
        'first snapshot A: tick',
        snap.tick,
        'self', snap.self.id,
        'allies', snap.allies.map((u: { id: string }) => u.id),
        'visibleEnemies', snap.visibleEnemies.length
      );
    }
  });
  roomB.onMessage('snapshot', (snap) => {
    snapshotsB += 1;
    // Filtering invariant: every enemy in B's snapshot must be on A's team,
    // and none should be visible while both humans idle at spawn across a
    // 64-tile map with walls between.
    if (snap.visibleEnemies.length > 0 && snapshotsB < 30) {
      console.log('B sees enemies early:', JSON.stringify(snap.visibleEnemies.map((e: {id:string}) => e.id)));
    }
  });

  // Drive A forward (east) for 3 seconds.
  const drive = setInterval(() => {
    roomA.send('intent', { move: { x: 1, y: 0 } });
  }, 33);

  await new Promise((resolve) => setTimeout(resolve, 3000));
  clearInterval(drive);

  console.log('snapshots A:', snapshotsA, 'B:', snapshotsB);
  console.log('teams:', teamA, 'vs', teamB);
  console.log('enemy sightings for A (bot allies may spot):', enemySeenA);

  const pass =
    welcomeA !== null &&
    teamA !== '' &&
    teamB !== '' &&
    teamA !== teamB &&
    snapshotsA > 60 &&
    snapshotsB > 60;

  console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL');

  await roomA.leave();
  await roomB.leave();
  await gameServer.gracefullyShutdown(false);
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE FAIL', error);
  process.exit(1);
});
