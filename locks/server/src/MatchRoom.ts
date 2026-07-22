// MatchRoom: the authoritative game loop. Gathers intents (sockets + bot
// brains), runs shared step() at the fixed tick rate, and sends each client
// snapshots and events filtered for that client's team.

import { Room, Client, ServerError } from '@colyseus/core';

import { GAME_CONFIG } from '../../client/src/shared/config.js';
import {
  applyPlayerCommand,
  clearUnitCommands,
  visibleUnitCommandState,
} from '../../client/src/shared/commands.js';
import type { Team } from '../../client/src/shared/config.js';
import { makeBotBrain, assignRole } from '../../client/src/shared/bots.js';
import type { BotBrain } from '../../client/src/shared/bots.js';
import {
  createGameState,
  isUnitVisibleToTeam,
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
import { verifyJoinToken } from './joinToken.js';
import { reportLobbyEvent } from './lobbyReporter.js';
import {
  sanitizePlayerCommandMessage,
  validatePlayerCommand,
} from './playerCommands.js';
import type { SanitizedPlayerCommandMessage } from './playerCommands.js';

type JoinOptions = { name?: string; token?: string; brokered?: boolean };

type JoinAuth = { name: string; jti: string };

type Seat = {
  unitId: string;
  client: Client | null;
  name: string;
  ready: boolean;
  latestIntent: Intent;
  pendingCommands: SanitizedPlayerCommandMessage[];
};

export class MatchRoom extends Room {
  maxClients = GAME_CONFIG.roster.length;
  autoDispose = false;

  private state_!: GameState;
  private seats: Seat[] = [];
  private botBrains: Map<string, BotBrain> = new Map();
  private shutdownScheduled = false;
  private brokered = false;
  private usedJoinTokens = new Set<string>();
  private readonly heartbeatTicks = Math.max(1, Math.round(30_000 / TICK_MS));

  onCreate(options: JoinOptions) {
    this.brokered = options.brokered === true;
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
      ready: false,
      latestIntent: IDLE_INTENT,
      pendingCommands: [],
    }));

    for (const entry of GAME_CONFIG.roster) {
      const teammates = GAME_CONFIG.roster.filter((r) => r.team === entry.team);
      const indexInTeam = teammates.findIndex((r) => r.id === entry.id);
      this.botBrains.set(entry.id, makeBotBrain(entry.id, assignRole(indexInTeam)));
    }

    // Clients say 'ready' after registering their message handlers. Until
    // then, do not send snapshots/events that could be lost during setup.
    this.onMessage('ready', (client) => {
      const seat = this.seats.find((s) => s.client === client);
      if (seat === undefined) return;

      seat.ready = true;
      const unit = this.state_.units[seat.unitId];
      client.send('welcome', {
        roomId: this.roomId,
        unitId: seat.unitId,
        team: unit.team,
        tickMs: TICK_MS,
      });
      client.send('snapshot', this.snapshotFor(seat.unitId));
      this.sendRosterToReadyClients();
      console.log(
        `[locks-game][room ${this.roomId}] ready unit=${seat.unitId} humans=${this.humanCount()}`
      );
    });

    this.onMessage('intent', (client, data: unknown) => {
      if (this.state_.match.phase === 'ended') return;
      const seat = this.seats.find((s) => s.client === client);
      if (seat === undefined || !seat.ready) return;
      seat.latestIntent = sanitizeIntent(data);
    });

    // Commands are buffered until the next fixed simulation tick, validated,
    // and then executed by the deterministic shared waypoint system.
    this.onMessage('command', (client, data: unknown) => {
      if (this.state_.match.phase === 'ended') return;
      const seat = this.seats.find((s) => s.client === client);
      if (seat === undefined || !seat.ready) return;
      const parsed = sanitizePlayerCommandMessage(data);
      if (parsed === null) return;
      // Bound pre-tick input buffering separately from the simulation queue.
      if (seat.pendingCommands.length >= 32) return;
      seat.pendingCommands.push(parsed);
    });

    console.log(
      `[locks-game][room ${this.roomId}] created brokered=${this.brokered} seats=${this.maxClients}`
    );
    this.setSimulationInterval(() => this.tickSafely(), TICK_MS);

    if (this.brokered) {
      void reportLobbyEvent({
        type: 'room_created',
        roomId: this.roomId,
        humanCount: 0,
      });
    }
  }

  onAuth(_client: Client, options: JoinOptions): JoinAuth {
    const token = typeof options.token === 'string' ? options.token : '';
    const secret =
      process.env.JOIN_TOKEN_SECRET ??
      process.env.SERVICE_SHARED_SECRET ??
      (process.env.NODE_ENV === 'production' ? '' : 'locks-dev-secret-change-me');

    if (token.length > 0) {
      const verified = verifyJoinToken(token, secret, this.roomId);
      if (verified === null) throw new ServerError(401, 'Invalid or expired join token');
      if (this.usedJoinTokens.has(verified.jti)) {
        throw new ServerError(401, 'Join token already used');
      }
      this.usedJoinTokens.add(verified.jti);
      return { name: verified.name, jti: verified.jti };
    }

    const allowLegacy =
      !this.brokered &&
      (process.env.ALLOW_LEGACY_JOIN ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')) ===
        'true';
    if (allowLegacy) {
      const requestedName = typeof options.name === 'string' ? options.name.trim() : '';
      return { name: (requestedName || 'Player').slice(0, 16), jti: 'legacy' };
    }

    throw new ServerError(401, 'Quick-play token required');
  }

  onJoin(client: Client, options: JoinOptions, auth?: JoinAuth) {
    if (this.state_.match.phase === 'ended' || this.shutdownScheduled) {
      client.leave(4001, 'Match has ended');
      return;
    }

    const seat = this.seats.find((s) => s.client === null);
    if (seat === undefined) {
      client.leave(4000, 'Match is full');
      return;
    }

    const authenticatedName = auth?.name ?? '';
    const requestedName = typeof options.name === 'string' ? options.name.trim() : '';
    seat.client = client;
    seat.name = (authenticatedName || requestedName || 'Player').slice(0, 16);
    seat.ready = false;
    seat.latestIntent = IDLE_INTENT;
    seat.pendingCommands = [];
    clearUnitCommands(this.state_.commands[seat.unitId]);

    // The name becomes the unit's in-world label; reverts to the roster label
    // when the seat drops back to a bot.
    this.state_.units[seat.unitId].label = seat.name;

    // Existing ready clients should see the reservation immediately. The new
    // client gets its roster only after its own handlers are ready.
    this.sendRosterToReadyClients();
    console.log(
      `[locks-game][room ${this.roomId}] joined unit=${seat.unitId} name=${JSON.stringify(seat.name)} humans=${this.humanCount()}`
    );
    if (this.brokered) {
      void reportLobbyEvent({
        type: 'player_joined',
        roomId: this.roomId,
        humanCount: this.humanCount(),
      });
    }
  }

  onLeave(client: Client, consented: boolean) {
    const seat = this.seats.find((s) => s.client === client);
    if (seat === undefined) return;
    seat.client = null;
    seat.ready = false;
    seat.latestIntent = IDLE_INTENT; // seat reverts to bot control
    seat.pendingCommands = [];
    clearUnitCommands(this.state_.commands[seat.unitId]);
    // Label reverts to the roster default (e.g. "R1") now that a bot drives it.
    const rosterEntry = GAME_CONFIG.roster.find((r) => r.id === seat.unitId);
    if (rosterEntry !== undefined) this.state_.units[seat.unitId].label = rosterEntry.label;
    seat.name = rosterEntry?.label ?? seat.name;
    this.sendRosterToReadyClients();
    console.log(
      `[locks-game][room ${this.roomId}] left unit=${seat.unitId} humans=${this.humanCount()} consented=${consented}`
    );
    if (this.brokered) {
      void reportLobbyEvent({
        type: 'player_left',
        roomId: this.roomId,
        humanCount: this.humanCount(),
      });
    }
  }

  async onDispose() {
    console.log(
      `[locks-game][room ${this.roomId}] disposed tick=${this.state_?.tick ?? -1} humans=${this.humanCount()}`
    );
    if (this.brokered) {
      await reportLobbyEvent({
        type: 'room_disposed',
        roomId: this.roomId,
        humanCount: this.humanCount(),
      });
    }
  }

  private tickSafely() {
    try {
      this.tick();
    } catch (error) {
      console.error(
        `[locks-game][room ${this.roomId}] simulation tick failed at tick=${this.state_?.tick ?? -1}`,
        error
      );
      this.shutdownScheduled = true;
      try {
        void this.lock();
      } catch {
        // Room may already be locked while handling the failure.
      }
      try {
        void Promise.resolve(this.disconnect()).catch(() => {});
      } catch {
        // Room may already be disposing.
      }
    }
  }

  private applyPendingCommands(seat: Seat) {
    if (seat.pendingCommands.length === 0) return;
    const pending = seat.pendingCommands.splice(0);
    for (const message of pending) {
      const validated = validatePlayerCommand(
        this.state_,
        seat.unitId,
        message.command
      );
      if (validated === null) continue;
      applyPlayerCommand(
        this.state_.commands[seat.unitId],
        validated,
        message.queue ? 'append' : 'replace'
      );
      if (validated.type === 'stop') this.state_.units[seat.unitId].lock = null;
    }
  }

  private tick() {
    if (this.shutdownScheduled) return;

    const visibleBefore = this.visibleUnitIdsByTeam();
    const intents: Record<string, Intent> = {};

    for (const seat of this.seats) {
      if (seat.client !== null && seat.ready) {
        this.applyPendingCommands(seat);
        intents[seat.unitId] = validateIntentForUnit(
          this.state_,
          seat.unitId,
          seat.latestIntent
        );
        // Lock/cancel orders are one-shot; movement persists between ticks.
        seat.latestIntent = { move: seat.latestIntent.move };
      } else if (seat.client !== null) {
        // A connected-but-not-ready player owns the seat but remains idle.
        intents[seat.unitId] = IDLE_INTENT;
      } else {
        const brain = this.botBrains.get(seat.unitId)!;
        intents[seat.unitId] = brain(perceive(this.state_, seat.unitId));
      }
    }

    const events = step(this.state_, intents);
    const visibleAfter = this.visibleUnitIdsByTeam();

    if (events.length > 0) {
      const filteredByTeam = new Map<Team, GameEvent[]>();
      for (const team of ['red', 'blue'] satisfies Team[]) {
        filteredByTeam.set(
          team,
          filterEventsForTeam(
            events,
            team,
            this.state_,
            visibleBefore.get(team) ?? new Set(),
            visibleAfter.get(team) ?? new Set()
          )
        );
      }

      for (const seat of this.seats) {
        if (seat.client === null || !seat.ready) continue;
        const team = this.state_.units[seat.unitId].team;
        const safeEvents = filteredByTeam.get(team) ?? [];
        if (safeEvents.length > 0) seat.client.send('events', safeEvents);
      }
    }

    for (const seat of this.seats) {
      if (seat.client === null || !seat.ready) continue;
      seat.client.send('snapshot', this.snapshotFor(seat.unitId));
    }

    if (this.state_.tick % this.heartbeatTicks === 0) {
      console.log(
        `[locks-game][room ${this.roomId}] heartbeat tick=${this.state_.tick} humans=${this.humanCount()} phase=${this.state_.match.phase} score=${this.state_.ctf.scores.red}-${this.state_.ctf.scores.blue}`
      );
    }

    if (this.state_.match.phase === 'ended') {
      console.log(
        `[locks-game][room ${this.roomId}] match ended tick=${this.state_.tick} result=${this.state_.match.result ?? 'draw'} score=${this.state_.ctf.scores.red}-${this.state_.ctf.scores.blue}`
      );
      // Leave the final state visible briefly, reject new joins, report the
      // idempotent result, then close the disposable room once.
      this.shutdownScheduled = true;
      if (this.brokered) {
        void reportLobbyEvent({
          type: 'match_ended',
          roomId: this.roomId,
          humanCount: this.humanCount(),
          result: this.state_.match.result ?? 'draw',
          scoreRed: this.state_.ctf.scores.red,
          scoreBlue: this.state_.ctf.scores.blue,
        });
      }
      void this.lock();
      this.clock.setTimeout(() => {
        void this.disconnect();
      }, 10_000);
    }
  }

  private humanCount(): number {
    return this.seats.filter((seat) => seat.client !== null).length;
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
      commands: visibleUnitCommandState(this.state_.commands[unitId]),
    };
  }

  private visibleUnitIdsByTeam(): Map<Team, Set<string>> {
    const result = new Map<Team, Set<string>>();

    for (const seat of this.seats) {
      const team = this.state_.units[seat.unitId].team;
      if (result.has(team)) continue;

      const view = perceive(this.state_, seat.unitId);
      result.set(
        team,
        new Set([
          view.self.id,
          ...view.allies.map((unit) => unit.id),
          ...view.visibleEnemies.map((unit) => unit.id),
        ])
      );
    }

    return result;
  }

  private sendRosterToReadyClients() {
    const roster = this.rosterInfo();
    for (const seat of this.seats) {
      if (seat.client !== null && seat.ready) {
        seat.client.send('roster', roster);
      }
    }
  }

  private rosterInfo() {
    return this.seats.map((seat) => ({
      unitId: seat.unitId,
      name: seat.client !== null ? seat.name : `${seat.name} (bot)`,
      human: seat.client !== null,
      ready: seat.client !== null && seat.ready,
    }));
  }
}

function sanitizeIntent(data: unknown): Intent {
  const payload = isRecord(data) ? data : {};
  const rawMove = isRecord(payload.move) ? payload.move : {};
  const x = finiteNumber(rawMove.x);
  const y = finiteNumber(rawMove.y);
  const length = Math.hypot(x, y);
  const move = length > 1 ? { x: x / length, y: y / length } : { x, y };

  const intent: Intent = { move };

  // Give cancel precedence if a malformed client sends both commands.
  if (payload.cancelLock === true) {
    intent.cancelLock = true;
  } else if (typeof payload.lockTargetId === 'string') {
    intent.lockTargetId = payload.lockTargetId.slice(0, 32);
  }

  return intent;
}

function validateIntentForUnit(
  state: GameState,
  unitId: string,
  intent: Intent
): Intent {
  const validated: Intent = { move: intent.move };

  if (intent.cancelLock === true) {
    validated.cancelLock = true;
    return validated;
  }

  if (typeof intent.lockTargetId !== 'string') return validated;

  const source = state.units[unitId];
  const target = state.units[intent.lockTargetId];
  if (
    source !== undefined &&
    target !== undefined &&
    source.alive &&
    target.alive &&
    source.team !== target.team &&
    isUnitVisibleToTeam(state, source.team, target)
  ) {
    validated.lockTargetId = target.id;
  }

  return validated;
}

function filterEventsForTeam(
  events: GameEvent[],
  team: Team,
  state: GameState,
  visibleBefore: Set<string>,
  visibleAfter: Set<string>
): GameEvent[] {
  const knownUnitIds = new Set([...visibleBefore, ...visibleAfter]);
  const safeEvents: GameEvent[] = [];

  for (const event of events) {
    const safe = filterEventForTeam(event, team, state, knownUnitIds);
    if (safe !== null) safeEvents.push(safe);
  }

  return safeEvents;
}

function filterEventForTeam(
  event: GameEvent,
  team: Team,
  state: GameState,
  knownUnitIds: Set<string>
): GameEvent | null {
  const raw = event as unknown as Record<string, unknown>;

  if (event.type === 'shot') {
    const shooterId = firstString(raw, ['shooterId', 'byId', 'unitId']);
    const targetId = firstString(raw, ['targetId', 'victimId']);

    // A tracer contains two world positions. Only send it when the team is
    // entitled to both endpoints. If future event shapes omit participant
    // IDs, dropping the event is safer than leaking coordinates.
    if (shooterId === null || targetId === null) return null;
    if (!knownUnitIds.has(shooterId) || !knownUnitIds.has(targetId)) return null;
    return event;
  }

  if (event.type === 'kill') {
    const victimId = firstString(raw, ['unitId', 'victimId', 'targetId']);
    if (victimId === null) return null;

    const victimTeam = state.units[victimId]?.team;
    if (victimTeam !== team && !knownUnitIds.has(victimId)) return null;

    // The victim/location can be known while the attacker remains hidden.
    // Preserve the death event but remove hidden-attacker identity fields.
    const sanitized = { ...raw };
    for (const key of ['killerId', 'shooterId', 'byId']) {
      const id = sanitized[key];
      if (typeof id === 'string' && !knownUnitIds.has(id)) delete sanitized[key];
    }
    return sanitized as unknown as GameEvent;
  }

  // Current non-combat events contain no world coordinates and are public.
  // For any future positional event, fail closed unless every attached unit
  // ID is known to this team.
  if (containsWorldPosition(raw)) {
    const relatedIds = ['unitId', 'byId', 'shooterId', 'targetId', 'victimId', 'killerId']
      .map((key) => raw[key])
      .filter((value): value is string => typeof value === 'string');
    if (relatedIds.length === 0 || relatedIds.some((id) => !knownUnitIds.has(id))) {
      return null;
    }
  }

  return event;
}

function containsWorldPosition(value: Record<string, unknown>): boolean {
  return ['from', 'to', 'at', 'pos', 'position'].some((key) => isVec2(value[key]));
}

function isVec2(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function firstString(
  value: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key];
  }
  return null;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
