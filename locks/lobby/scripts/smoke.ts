// Lobby smoke: guest sessions, quick-play prefer-populated selection, signed
// token issuance, lifecycle auth, and basic validation. No DB/game required.

import { buildLobbyApp } from '../src/index.js';
import type { GameApi, GameRoomStatus } from '../src/gameApi.js';

const PORT = Number(process.env.LOBBY_SMOKE_PORT ?? 2578);
const SECRET = 'smoke-secret-at-least-16-chars';

class FakeGameApi implements GameApi {
  private rooms = new Map<string, GameRoomStatus>();
  private nextId = 1;

  async createRoom() {
    const roomId = `room-${this.nextId++}`;
    this.rooms.set(roomId, {
      exists: true,
      roomId,
      joinable: true,
      humanCount: 0,
      maxClients: 6,
    });
    return { roomId };
  }

  async roomStatus(roomId: string) {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      return { exists: false, roomId, joinable: false, humanCount: 0, maxClients: 0 };
    }
    return room;
  }
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function createGuest(base: string, name: string) {
  return json(
    await fetch(`${base}/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  );
}

async function play(base: string, token: string) {
  return json(
    await fetch(`${base}/play`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: '{}',
    })
  );
}

async function main() {
  const { app } = await buildLobbyApp({
    gameApi: new FakeGameApi(),
    sharedSecret: SECRET,
    joinTokenSecret: SECRET,
    gamePublicUrl: 'ws://localhost:2599',
  });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${PORT}`;

  try {
    const health = await json(await fetch(`${base}/health`));
    console.log('health:', JSON.stringify(health));

    const guestA = await createGuest(base, 'Nathan');
    const guestB = await createGuest(base, 'Rachel');
    const playA = await play(base, String(guestA.token));
    const playB = await play(base, String(guestB.token));

    const invalid = await fetch(`${base}/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: '{}',
    });
    const unauthorizedLifecycle = await fetch(`${base}/internal/game-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-locks-secret': 'wrong' },
      body: JSON.stringify({ type: 'room_created', roomId: 'x', humanCount: 0 }),
    });

    console.log('guest A:', JSON.stringify(guestA));
    console.log('play A:', JSON.stringify(playA));
    console.log('play B:', JSON.stringify(playB));

    const pass =
      health.ok === true &&
      guestA.name === '~Nathan' &&
      typeof guestA.token === 'string' &&
      playA.roomId === playB.roomId &&
      typeof playA.joinToken === 'string' &&
      String(playA.joinToken).includes('.') &&
      playA.gameServerUrl === 'ws://localhost:2599' &&
      invalid.status === 401 &&
      unauthorizedLifecycle.status === 401;

    console.log(pass ? 'LOBBY SMOKE PASS' : 'LOBBY SMOKE FAIL');
    process.exitCode = pass ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('LOBBY SMOKE FAIL', error);
  process.exit(1);
});
