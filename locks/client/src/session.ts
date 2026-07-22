// Game sessions: the render layer consumes Frames and doesn't care whether
// they came from a local sim or the authoritative server.

import { Client as ColyseusClient, Room } from 'colyseus.js';

import type { Vec2 } from './shared/geometry';
import { applyPlayerCommand, visibleUnitCommandState } from './shared/commands';
import type { PlayerCommand } from './shared/commands';
import { makeBotBrain, assignRole } from './shared/bots';
import { GAME_CONFIG } from './shared/config';
import type { BotBrain } from './shared/bots';
import type { Snapshot, WelcomeMessage } from './shared/protocol';
import {
  createGameState,
  isUnitVisibleToTeam,
  perceive,
  remainingRoundMs,
  step,
  TICK_MS,
} from './shared/state';
import type { GameEvent, GameState, Intent } from './shared/state';

export type Frame = {
  view: Snapshot;
  prev: Map<string, Vec2>;
  alpha: number; // 0..1 interpolation between prev and view positions
  events: GameEvent[];
};

export type SessionConnectionStatus =
  | { state: 'connected' }
  | { state: 'connecting' }
  | { state: 'stale'; staleForMs: number }
  | { state: 'closed'; code: number; message: string; expected: boolean }
  | { state: 'error'; code: number; message: string };

export interface GameSession {
  readonly mode: 'practice' | 'online';
  readonly playerId: string;
  update(deltaMs: number, intent: Intent): void;
  issueCommand(command: PlayerCommand, queue: boolean): void;
  frame(): Frame | null; // null until the session has produced a view
  connectionStatus(): SessionConnectionStatus;
  dispose(): void;
}

// ---------------------------------------------------------------- practice

export class LocalSession implements GameSession {
  readonly mode = 'practice' as const;
  readonly playerId = 'r1';

  private difficulty: string;
  private state: GameState = createGameState();
  private brains: Map<string, BotBrain> = new Map();

  constructor(difficulty: string = GAME_CONFIG.defaultBotDifficulty) {
    this.difficulty = difficulty;
  }
  private accumulator = 0;
  private prev: Map<string, Vec2> = new Map();
  private pendingEvents: GameEvent[] = [];

  update(deltaMs: number, intent: Intent): void {
    this.accumulator = Math.min(this.accumulator + deltaMs, TICK_MS * 8);

    while (this.accumulator >= TICK_MS && this.state.match.phase !== 'ended') {
      this.prev = new Map(
        Object.values(this.state.units).map((unit) => [unit.id, { ...unit.pos }])
      );

      const intents: Record<string, Intent> = {};
      for (const unit of Object.values(this.state.units)) {
        if (unit.id === this.playerId) {
          intents[unit.id] = intent;
        } else {
          let brain = this.brains.get(unit.id);
          if (brain === undefined) {
            const teammates = GAME_CONFIG.roster.filter((r) => r.team === unit.team);
            const indexInTeam = teammates.findIndex((r) => r.id === unit.id);
            brain = makeBotBrain(
              unit.id,
              assignRole(indexInTeam),
              GAME_CONFIG.botDifficulties[this.difficulty]
            );
            this.brains.set(unit.id, brain);
          }
          intents[unit.id] = brain(perceive(this.state, unit.id));
        }
      }

      this.pendingEvents.push(...step(this.state, intents));
      this.accumulator -= TICK_MS;

      // Lock/cancel orders are one-shot; don't reapply on a second step
      // within the same rendered frame.
      delete intent.lockTargetId;
      delete intent.cancelLock;
    }
  }

  issueCommand(command: PlayerCommand, queue: boolean): void {
    const unit = this.state.units[this.playerId];
    if (!unit.alive || this.state.match.phase === 'ended') return;

    if (command.type === 'attack') {
      const target = this.state.units[command.targetId];
      if (
        target === undefined ||
        !target.alive ||
        target.team === unit.team ||
        !isUnitVisibleToTeam(this.state, unit.team, target)
      ) {
        return;
      }
      applyPlayerCommand(
        this.state.commands[this.playerId],
        {
          type: 'attack',
          targetId: target.id,
          lastKnownPosition: { ...target.pos },
        },
        queue ? 'append' : 'replace'
      );
      return;
    }

    applyPlayerCommand(
      this.state.commands[this.playerId],
      command,
      queue ? 'append' : 'replace'
    );
    if (command.type === 'stop') unit.lock = null;
  }

  frame(): Frame {
    const view: Snapshot = {
      ...perceive(this.state, this.playerId),
      remainingMs: remainingRoundMs(this.state),
      commands: visibleUnitCommandState(this.state.commands[this.playerId]),
    };
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return { view, prev: this.prev, alpha: this.accumulator / TICK_MS, events };
  }

  connectionStatus(): SessionConnectionStatus {
    return { state: 'connected' };
  }

  dispose(): void {}
}

// ------------------------------------------------------------------ online

export class OnlineSession implements GameSession {
  readonly mode = 'online' as const;

  playerId = '';

  private room: Room;
  private view: Snapshot | null = null;
  private prevView: Snapshot | null = null;
  private lastSnapshotAt = 0;
  private pendingEvents: GameEvent[] = [];
  private sendAccumulator = 0;
  private disposed = false;
  private closed: { code: number; message: string; expected: boolean } | null = null;
  private roomError: { code: number; message: string } | null = null;

  private static readonly SNAPSHOT_STALE_MS = 3_000;

  private constructor(room: Room) {
    this.room = room;
  }

  static async create(
    lobbyUrl: string,
    fallbackServerUrl: string,
    name: string
  ): Promise<OnlineSession> {
    const guest = await postJson<GuestResponse>(`${trimSlash(lobbyUrl)}/guest`, { name });
    let room: Room | null = null;
    let lastJoinError: unknown = null;

    // A room can end or fill between the broker response and the Colyseus
    // handshake. Ask the broker for one fresh token before surfacing failure.
    for (let attempt = 0; attempt < 2 && room === null; attempt++) {
      const play = await postJson<QuickPlayResponse>(
        `${trimSlash(lobbyUrl)}/play`,
        {},
        guest.token
      );
      const client = new ColyseusClient(play.gameServerUrl || fallbackServerUrl);
      try {
        room = await client.joinById(play.roomId, { token: play.joinToken });
      } catch (error) {
        lastJoinError = error;
      }
    }

    if (room === null) {
      throw lastJoinError instanceof Error
        ? lastJoinError
        : new Error('Could not join the selected match');
    }

    const session = new OnlineSession(room);
    let welcomeSettled = false;
    let welcomeTimeout = 0;
    let rejectWelcome: (error: Error) => void = () => {};

    const welcome = new Promise<void>((resolve, reject) => {
      rejectWelcome = reject;
      welcomeTimeout = window.setTimeout(() => {
        if (welcomeSettled) return;
        welcomeSettled = true;
        reject(new Error('Server welcome timed out'));
      }, 8_000);

      room.onMessage('welcome', (data: WelcomeMessage) => {
        session.playerId = data.unitId;
        if (welcomeSettled) return;
        welcomeSettled = true;
        window.clearTimeout(welcomeTimeout);
        resolve();
      });
    });

    room.onMessage('snapshot', (snap: Snapshot) => {
      session.prevView = session.view;
      session.view = snap;
      session.lastSnapshotAt = performance.now();
    });
    room.onMessage('events', (events: GameEvent[]) => {
      session.pendingEvents.push(...events);
    });
    room.onMessage('roster', () => {});

    room.onError((code: number, message?: string) => {
      const safeMessage = message || 'The game server reported an error.';
      session.roomError = { code, message: safeMessage };
      console.error(`[locks] room error code=${code} message=${JSON.stringify(safeMessage)}`);
      if (!welcomeSettled) {
        welcomeSettled = true;
        window.clearTimeout(welcomeTimeout);
        rejectWelcome(new Error(`Game server error (${code}): ${safeMessage}`));
      }
    });

    room.onLeave((code: number) => {
      const expected =
        session.disposed || session.view?.match.phase === 'ended' || code === 4001;
      const message = describeCloseCode(code);
      session.closed = { code, message, expected };
      const logMessage =
        `[locks] room left code=${code} expected=${expected} ` +
        `phase=${session.view?.match.phase ?? 'unknown'} message=${JSON.stringify(message)}`;
      if (expected) console.info(logMessage);
      else console.warn(logMessage);
      if (!welcomeSettled) {
        welcomeSettled = true;
        window.clearTimeout(welcomeTimeout);
        rejectWelcome(new Error(`${message} (code ${code})`));
      }
    });

    try {
      room.send('ready');
      await welcome;
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }

  update(deltaMs: number, intent: Intent): void {
    if (this.disposed || this.closed !== null || this.roomError !== null) return;

    this.sendAccumulator += deltaMs;
    const hasOrder = intent.lockTargetId !== undefined || intent.cancelLock === true;
    if (this.sendAccumulator >= TICK_MS || hasOrder) {
      this.room.send('intent', intent);
      this.sendAccumulator = 0;
    }
  }

  issueCommand(command: PlayerCommand, queue: boolean): void {
    if (this.disposed || this.closed !== null || this.roomError !== null) return;
    this.room.send('command', { command, queue });
  }

  frame(): Frame | null {
    if (this.view === null) return null;

    const prev = new Map<string, Vec2>();
    if (this.prevView !== null) {
      const collect = (units: Array<{ id: string; pos: Vec2 }>) => {
        for (const unit of units) prev.set(unit.id, unit.pos);
      };
      collect([this.prevView.self, ...this.prevView.allies, ...this.prevView.visibleEnemies]);
    }

    const alpha = Math.min(1, (performance.now() - this.lastSnapshotAt) / TICK_MS);
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return { view: this.view, prev, alpha, events };
  }

  connectionStatus(): SessionConnectionStatus {
    if (this.roomError !== null) return { state: 'error', ...this.roomError };
    if (this.closed !== null) return { state: 'closed', ...this.closed };
    if (this.view === null || this.lastSnapshotAt === 0) return { state: 'connecting' };

    const staleForMs = performance.now() - this.lastSnapshotAt;
    if (staleForMs >= OnlineSession.SNAPSHOT_STALE_MS) {
      return { state: 'stale', staleForMs };
    }
    return { state: 'connected' };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.room.leave();
  }
}

function describeCloseCode(code: number): string {
  switch (code) {
    case 1000:
      return 'The match connection closed.';
    case 1001:
      return 'The browser or server closed the connection.';
    case 1002:
      return 'The game connection encountered a protocol error.';
    case 1003:
      return 'The game connection received unsupported data.';
    case 1005:
      return 'The connection closed without a status code.';
    case 1006:
      return 'The connection ended unexpectedly.';
    case 1011:
      return 'The game server encountered an internal error.';
    case 4000:
      return 'The selected match is full.';
    case 4001:
      return 'The selected match has ended.';
    default:
      return code >= 4000 && code <= 4999
        ? 'The game server closed the match connection.'
        : 'The match connection was lost.';
  }
}


type GuestResponse = {
  token: string;
  name: string;
  expiresAt: string;
};

type QuickPlayResponse = {
  roomId: string;
  joinToken: string;
  expiresAt: string;
  gameServerUrl: string;
};

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  bearerToken?: string
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      throw new Error(payload?.error ?? `Lobby request failed (${response.status})`);
    }
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, '');
}
