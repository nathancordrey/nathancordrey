// Game sessions: the render layer consumes Frames and doesn't care whether
// they came from a local sim or the authoritative server.

import { Client as ColyseusClient, Room } from 'colyseus.js';

import type { Vec2 } from './shared/geometry';
import { makeBotBrain, assignRole } from './shared/bots';
import { GAME_CONFIG } from './shared/config';
import type { BotBrain } from './shared/bots';
import type { Snapshot, WelcomeMessage } from './shared/protocol';
import {
  createGameState,
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

export interface GameSession {
  readonly mode: 'practice' | 'online';
  readonly playerId: string;
  update(deltaMs: number, intent: Intent): void;
  frame(): Frame | null; // null until the session has produced a view
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

  frame(): Frame {
    const view: Snapshot = {
      ...perceive(this.state, this.playerId),
      remainingMs: remainingRoundMs(this.state),
    };
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return { view, prev: this.prev, alpha: this.accumulator / TICK_MS, events };
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

  private constructor(room: Room) {
    this.room = room;
  }

  static async create(serverUrl: string, name: string): Promise<OnlineSession> {
    const client = new ColyseusClient(serverUrl);
    const room = await client.joinOrCreate('match', { name });
    const session = new OnlineSession(room);

    const welcome = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server welcome timed out')), 8000);
      room.onMessage('welcome', (data: WelcomeMessage) => {
        session.playerId = data.unitId;
        clearTimeout(timeout);
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

    room.send('ready');
    await welcome;
    return session;
  }

  update(deltaMs: number, intent: Intent): void {
    this.sendAccumulator += deltaMs;
    const hasOrder = intent.lockTargetId !== undefined || intent.cancelLock === true;
    if (this.sendAccumulator >= TICK_MS || hasOrder) {
      this.room.send('intent', intent);
      this.sendAccumulator = 0;
    }
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

  dispose(): void {
    void this.room.leave();
  }
}
