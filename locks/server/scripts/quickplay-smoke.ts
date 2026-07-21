// End-to-end Slice 3 smoke. Boots lobby + game services, requests two guest
// quick-play joins, confirms prefer-populated routing, validates signed-token
// auth, and proves a forged token is rejected.

import { Client } from 'colyseus.js';

const GAME_PORT = Number(process.env.QUICKPLAY_GAME_PORT ?? 2599);
const LOBBY_PORT = Number(process.env.QUICKPLAY_LOBBY_PORT ?? 2598);
const SECRET = 'quickplay-smoke-secret-32-characters';

process.env.NODE_ENV = 'test';
process.env.SERVICE_SHARED_SECRET = SECRET;
process.env.JOIN_TOKEN_SECRET = SECRET;
process.env.GAME_INTERNAL_URL = `http://127.0.0.1:${GAME_PORT}`;
process.env.GAME_PUBLIC_URL = `ws://127.0.0.1:${GAME_PORT}`;
process.env.LOBBY_INTERNAL_URL = `http://127.0.0.1:${LOBBY_PORT}/internal/game-events`;
process.env.ALLOW_LEGACY_JOIN = 'false';
delete process.env.DATABASE_URL;

const { createGameService } = await import('../src/index.js');
const { buildLobbyApp } = await import('../../lobby/src/index.js');

async function requestJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function guestAndPlay(base: string, name: string) {
  const guest = await requestJson(`${base}/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const play = await requestJson(`${base}/play`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${String(guest.token)}`,
    },
    body: '{}',
  });
  return { guest, play };
}

async function joinAndWelcome(
  client: Client,
  play: Record<string, unknown>
): Promise<{
  room: Awaited<ReturnType<Client['joinById']>>;
  welcome: Record<string, unknown>;
}> {
  const room = await client.joinById(String(play.roomId), {
    token: String(play.joinToken),
  });
  const welcomePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('welcome timed out')), 5_000);
    room.onMessage('welcome', (message: Record<string, unknown>) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
  room.onMessage('snapshot', () => {});
  room.onMessage('events', () => {});
  room.onMessage('roster', () => {});
  room.send('ready');
  return { room, welcome: await welcomePromise };
}

async function main() {
  const game = createGameService();
  const { app: lobby, store } = await buildLobbyApp();
  const joinedRooms: Array<Awaited<ReturnType<Client['joinById']>>> = [];

  try {
    await game.start(GAME_PORT);
    await lobby.listen({ port: LOBBY_PORT, host: '127.0.0.1' });

    const lobbyBase = `http://127.0.0.1:${LOBBY_PORT}`;

    const first = await guestAndPlay(lobbyBase, 'Nathan');
    const joinedA = await joinAndWelcome(
      new Client(String(first.play.gameServerUrl)),
      first.play
    );
    joinedRooms.push(joinedA.room);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await guestAndPlay(lobbyBase, 'Rachel');
    const joinedB = await joinAndWelcome(
      new Client(String(second.play.gameServerUrl)),
      second.play
    );
    joinedRooms.push(joinedB.room);

    // Check auth while the first room still has open seats.
    let forgedRejected = false;
    const forged = `${String(first.play.joinToken).slice(0, -1)}x`;
    try {
      await new Client(String(first.play.gameServerUrl)).joinById(
        String(first.play.roomId),
        { token: forged }
      );
    } catch {
      forgedRejected = true;
    }

    let replayRejected = false;
    try {
      await new Client(String(first.play.gameServerUrl)).joinById(
        String(first.play.roomId),
        { token: String(first.play.joinToken) }
      );
    } catch {
      replayRejected = true;
    }

    const plays = [first.play, second.play];
    for (const name of ['Claire', 'Luke', 'Cora']) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = await guestAndPlay(lobbyBase, name);
      plays.push(next.play);
      const joined = await joinAndWelcome(
        new Client(String(next.play.gameServerUrl)),
        next.play
      );
      joinedRooms.push(joined.room);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    const games = await store.listJoinableGames();
    const firstRoomId = String(plays[0]?.roomId);
    const filledFirstRoom = plays.slice(0, 4).every((play) => play.roomId === firstRoomId);
    const fifthGotFreshRoom = plays[4]?.roomId !== firstRoomId;

    console.log('brokered room IDs:', plays.map((play) => play.roomId));
    console.log('first welcomes:', joinedA.welcome, joinedB.welcome);
    console.log('tracked games:', games);
    console.log('forged token rejected:', forgedRejected);
    console.log('replayed token rejected:', replayRejected);

    const counts = games.map((entry) => entry.playerCount).sort((a, b) => b - a);
    const pass =
      filledFirstRoom &&
      fifthGotFreshRoom &&
      joinedA.welcome.team !== joinedB.welcome.team &&
      forgedRejected &&
      replayRejected &&
      games.length === 2 &&
      counts[0] === 4 &&
      counts[1] === 1;

    console.log(pass ? 'QUICKPLAY SMOKE PASS' : 'QUICKPLAY SMOKE FAIL');
    process.exitCode = pass ? 0 : 1;
  } finally {
    for (const room of joinedRooms) await room.leave().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await game.stop().catch(() => {});
    await lobby.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error('QUICKPLAY SMOKE FAIL', error);
  process.exit(1);
});
