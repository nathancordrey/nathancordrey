// MatchRoom: the authoritative game loop. Gathers intents (sockets + bot
// brains), runs shared step() at the fixed tick rate, broadcasts events, and
// sends each client a per-team snapshot built from perceive() — positions a
// team cannot see never cross the wire.

import { Room, Client } from 'colyseus';

import { GAME_CONFIG } from '../../client/src/shared/config.js';
import { makeAggroBrain } from '../../client/src/shared/bots.js';
import type { BotBrain } from '../../client/src/shared/bots.js';
import {
  createGameState,
  perceive,
  remainingRoundMs,
  step,
  IDLE_INTENT,
  TICK_MS,
} from '../../client/src/shared/state.js';
import type {
  GameEvent,
  GameState,
  Intent,
} from '../../client/src/shared/state.js';

type JoinOptions = { name?: string; token?: string };

type Seat = {
  unitId: string;
  client: Client | null;
  name: string;
  latestIntent: Intent;
};

export class MatchRoom extends Room {
  maxClients = GAME_CONFIG.roster.length;

  private state_!: GameState;
  private seats: Seat[] = [];
  private botBrains: Map<string, BotBrain> = new Map();

  onCreate(_options: JoinOptions) {
    this.state_ = createGameState();

    // Seats interleave red/blue so joiner #1 is red, #2 blue, #3 red...
    const red = GAME_CONFIG.roster.filter((r) => r.team === 'red');
    const blue = GAME_CONFIG.roster.filter((r) => r.team === 'blue');
    const ordered: typeof GAME_CONFIG.roster = [];
    for (let i = 0; i < Math.max(red.length, blue.length); i++) {
      if (red[i]) ordered.push(red[i]);
      if (blue[i]) ordered.push(blue[i]);
    }
    this.seats = ordered.map((entry) => ({
      unitId: entry.id,
      client: null,
      name: entry.label,
      latestIntent: IDLE_INTENT,
    }));

    for (const entry of GAME_CONFIG.roster) {
      this.botBrains.set(entry.id, makeAggroBrain(entry.id));
    }

    // Clients say 'ready' once handlers are registered; reply with seat info.
    this.onMessage('ready', (client) => {
      const seat = this.seats.find((s) => s.client === client);
      if (seat === undefined) return;
      const unit = this.state_.units[seat.unitId];
      client.send('welcome', { unitId: seat.unitId, team: unit.team, tickMs: TICK_MS });
      client.send('roster', this.rosterInfo());
    });

    this.onMessage('intent', (client, data: Intent) => {
      const seat = this.seats.find((s) => s.client === client);
      if (seat === undefined) return;
      seat.latestIntent = sanitizeIntent(data);
    });

    this.setSimulationInterval(() => this.tick(), TICK_MS);
  }

  onJoin(client: Client, options: JoinOptions) {
    // Token stub: the lobby's signed join token slots in here later.
    const seat = this.seats.find((s) => s.client === null);
    if (seat === undefined) {
      client.leave(4000, 'Match is full');
      return;
    }

    seat.client = client;
    seat.name = (options.name ?? 'Player').slice(0, 16);
    seat.latestIntent = IDLE_INTENT;

    this.broadcast('roster', this.rosterInfo());
  }

  onLeave(client: Client) {
    const seat = this.seats.find((s) => s.client === client);
    if (seat === undefined) return;
    seat.client = null;
    seat.latestIntent = IDLE_INTENT; // seat reverts to bot control
    this.broadcast('roster', this.rosterInfo());
  }

  private tick() {
    const intents: Record<string, Intent> = {};

    for (const seat of this.seats) {
      if (seat.client !== null) {
        intents[seat.unitId] = seat.latestIntent;
        // Lock/cancel orders are one-shot; movement persists between ticks.
        seat.latestIntent = { move: seat.latestIntent.move };
      } else {
        const brain = this.botBrains.get(seat.unitId)!;
        intents[seat.unitId] = brain(perceive(this.state_, seat.unitId));
      }
    }

    const events = step(this.state_, intents);

    if (events.length > 0) {
      // TODO(post-v0): filter shot/kill positions by team visibility too.
      this.broadcast('events', events satisfies GameEvent[]);
    }

    for (const seat of this.seats) {
      if (seat.client === null) continue;
      seat.client.send('snapshot', this.snapshotFor(seat.unitId));
    }

    if (this.state_.match.phase === 'ended') {
      // Report results to the lobby here later; for now just close shop.
      this.clock.setTimeout(() => this.disconnect(), 10_000);
    }
  }

  private snapshotFor(unitId: string) {
    const view = perceive(this.state_, unitId);
    return {
      tick: view.tick,
      remainingMs: remainingRoundMs(this.state_),
      match: view.match,
      scores: view.scores,
      flagsAtBase: view.flagsAtBase,
      carrierIds: view.carrierIds,
      self: view.self,
      allies: view.allies,
      visibleEnemies: view.visibleEnemies,
    };
  }

  private rosterInfo() {
    return this.seats.map((seat) => ({
      unitId: seat.unitId,
      name: seat.client !== null ? seat.name : `${seat.name} (bot)`,
      human: seat.client !== null,
    }));
  }
}

function sanitizeIntent(data: Intent): Intent {
  const move = data?.move ?? { x: 0, y: 0 };
  const length = Math.hypot(move.x, move.y);
  const clamped =
    length > 1 && length > 0
      ? { x: move.x / length, y: move.y / length }
      : { x: move.x || 0, y: move.y || 0 };

  const intent: Intent = { move: clamped };
  if (typeof data?.lockTargetId === 'string') intent.lockTargetId = data.lockTargetId;
  if (data?.cancelLock === true) intent.cancelLock = true;
  return intent;
}
