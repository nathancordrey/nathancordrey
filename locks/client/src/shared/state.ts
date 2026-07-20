// The game state machine. Pure simulation: no Phaser, no DOM, no wall-clock.
// step(state, intents) advances one fixed tick and returns events.
// The client, bots, and the future server all drive this same function.

import type { Vec2 } from './geometry';
import { distance } from './geometry';
import type { Team } from './config';
import { GAME_CONFIG, MAP } from './config';
import type { CtfState, MatchResult, MatchState } from './sim';
import {
  canFireAtTarget,
  carriedFlagTeam,
  createCtfState,
  createMatchState,
  evaluateMatch,
  isTargetVisibleFromAny,
  moveCircle,
  returnFlagOnDeath,
  tryCaptureFlag,
  tryGrabFlag,
  turnTowards,
  angleDelta,
} from './sim';

export const TICK_MS = 1000 / GAME_CONFIG.tickRate;

export function msToTicks(ms: number): number {
  return Math.max(1, Math.round(ms / TICK_MS));
}

export function ticksToMs(ticks: number): number {
  return ticks * TICK_MS;
}

// --- Types ----------------------------------------------------------------

export type UnitControl = 'player' | 'bot';

export type UnitLock = {
  targetId: string;
  createdAtTick: number;
  lastKnownPosition: Vec2;
};

export type VisionSample = { pos: Vec2; atTick: number };

export type Unit = {
  id: string;
  team: Team;
  control: UnitControl;
  label: string;
  spawn: Vec2;
  initialFacing: number;

  pos: Vec2;
  facingRadians: number;
  alive: boolean;
  respawnAtTick: number | null;

  lock: UnitLock | null;
  lastShotAtTick: number;

  visionSamples: VisionSample[];
  lastVisionSampleTick: number;

  campStartedTick: number | null;
  campExitedTick: number | null;
};

export type Intent = {
  move: Vec2; // desired direction; zero vector = no manual movement
  lockTargetId?: string;
  cancelLock?: boolean;
};

export const IDLE_INTENT: Intent = { move: { x: 0, y: 0 } };

export type GameState = {
  tick: number;
  units: Record<string, Unit>;
  ctf: CtfState;
  match: MatchState;
};

export type GameEvent =
  | { type: 'shot'; shooterId: string; from: Vec2; to: Vec2 }
  | { type: 'kill'; unitId: string; byId: string | null; reason: 'shot' | 'camping'; at: Vec2 }
  | { type: 'respawn'; unitId: string }
  | { type: 'flag-grab'; byId: string; flagTeam: Team }
  | { type: 'flag-capture'; byId: string; scoringTeam: Team }
  | { type: 'flag-return'; flagTeam: Team }
  | { type: 'match-end'; result: MatchResult };

// --- State creation -------------------------------------------------------

export function createGameState(): GameState {
  const units: Record<string, Unit> = {};

  for (const entry of GAME_CONFIG.roster) {
    const initialFacing = entry.team === 'red' ? 0 : Math.PI;
    units[entry.id] = {
      id: entry.id,
      team: entry.team,
      control: entry.control,
      label: entry.label,
      spawn: { ...entry.spawn },
      initialFacing,

      pos: { ...entry.spawn },
      facingRadians: initialFacing,
      alive: true,
      respawnAtTick: null,

      lock: null,
      lastShotAtTick: -1_000_000,

      visionSamples: [],
      lastVisionSampleTick: -1_000_000,

      campStartedTick: null,
      campExitedTick: null,
    };
  }

  return {
    tick: 0,
    units,
    ctf: createCtfState(),
    match: createMatchState(),
  };
}

// --- Team vision ----------------------------------------------------------

export function computeTeamViewpoints(state: GameState, team: Team): Vec2[] {
  const memoryTicks = msToTicks(GAME_CONFIG.visionMemoryMs);
  const viewpoints: Vec2[] = [];

  for (const unit of Object.values(state.units)) {
    if (unit.team !== team || !unit.alive) continue;
    viewpoints.push(unit.pos);
    for (const sample of unit.visionSamples) {
      if (state.tick - sample.atTick <= memoryTicks) viewpoints.push(sample.pos);
    }
  }

  return viewpoints;
}

export function isUnitVisibleToTeam(
  state: GameState,
  viewerTeam: Team,
  unit: Unit,
  viewpoints?: Vec2[]
): boolean {
  if (!unit.alive) return false;
  if (unit.team === viewerTeam) return true;

  return isTargetVisibleFromAny(
    viewpoints ?? computeTeamViewpoints(state, viewerTeam),
    viewerTeam,
    unit.pos,
    MAP.walls,
    GAME_CONFIG.playerVisionRadius,
    MAP.flags
  );
}

// --- Perception (what a team is allowed to know) --------------------------
// Bots read this instead of raw state; the server will use the same filter
// for client snapshots. Carrier IDENTITY is public; carrier POSITION is not.

export type PerceivedEnemy = {
  id: string;
  team: Team;
  pos: Vec2;
  facingRadians: number;
  carryingFlag: Team | null;
};

export type PerceivedState = {
  tick: number;
  match: MatchState;
  scores: Record<Team, number>;
  flagsAtBase: Record<Team, boolean>;
  carrierIds: Record<Team, string | null>;
  self: Unit;
  allies: Unit[];
  visibleEnemies: PerceivedEnemy[];
};

export function perceive(state: GameState, selfId: string): PerceivedState {
  const self = state.units[selfId];
  const team = self.team;
  const viewpoints = computeTeamViewpoints(state, team);

  const allies: Unit[] = [];
  const visibleEnemies: PerceivedEnemy[] = [];

  for (const unit of Object.values(state.units)) {
    if (unit.id === selfId) continue;
    if (unit.team === team) {
      if (unit.alive) allies.push(unit);
      continue;
    }
    if (isUnitVisibleToTeam(state, team, unit, viewpoints)) {
      visibleEnemies.push({
        id: unit.id,
        team: unit.team,
        pos: { ...unit.pos },
        facingRadians: unit.facingRadians,
        carryingFlag: carriedFlagTeam(state.ctf, unit.id),
      });
    }
  }

  return {
    tick: state.tick,
    match: state.match,
    scores: { ...state.ctf.scores },
    flagsAtBase: {
      red: state.ctf.flags.red.atBase,
      blue: state.ctf.flags.blue.atBase,
    },
    carrierIds: {
      red: state.ctf.flags.red.carrierId,
      blue: state.ctf.flags.blue.carrierId,
    },
    self,
    allies,
    visibleEnemies,
  };
}

// --- The tick -------------------------------------------------------------

export function step(state: GameState, intents: Record<string, Intent>): GameEvent[] {
  const events: GameEvent[] = [];
  if (state.match.phase === 'ended') return events;

  state.tick += 1;
  const t = state.tick;
  const tickSeconds = TICK_MS / 1000;

  const units = Object.values(state.units);

  // 1) Respawns.
  for (const unit of units) {
    if (!unit.alive && unit.respawnAtTick !== null && t >= unit.respawnAtTick) {
      unit.alive = true;
      unit.respawnAtTick = null;
      unit.pos = { ...unit.spawn };
      unit.facingRadians = unit.initialFacing;
      unit.lock = null;
      unit.visionSamples = [];
      unit.lastVisionSampleTick = -1_000_000;
      unit.campStartedTick = null;
      unit.campExitedTick = null;
      events.push({ type: 'respawn', unitId: unit.id });
    }
  }

  // 2) Visibility snapshot for this tick (start-of-tick positions).
  const viewpointsByTeam: Record<Team, Vec2[]> = {
    red: computeTeamViewpoints(state, 'red'),
    blue: computeTeamViewpoints(state, 'blue'),
  };
  const visibleTo = (viewerTeam: Team, unit: Unit) =>
    isUnitVisibleToTeam(state, viewerTeam, unit, viewpointsByTeam[viewerTeam]);

  // 3) Intents: lock management. Locks require the target to be in current
  // or lingering team vision at acquisition time.
  for (const unit of units) {
    if (!unit.alive) continue;
    const intent = intents[unit.id] ?? IDLE_INTENT;

    if (intent.cancelLock) unit.lock = null;

    if (intent.lockTargetId !== undefined) {
      const target = state.units[intent.lockTargetId];
      if (
        target !== undefined &&
        target.alive &&
        target.team !== unit.team &&
        visibleTo(unit.team, target)
      ) {
        unit.lock = {
          targetId: target.id,
          createdAtTick: t,
          lastKnownPosition: { ...target.pos },
        };
      }
    }
  }

  // 4) Movement + facing. Manual input overrides chase without cancelling
  // the lock. Hidden tracking chases the target's REAL position but the
  // perception layer never reveals it.
  for (const unit of units) {
    if (!unit.alive) continue;
    const intent = intents[unit.id] ?? IDLE_INTENT;

    let chasePoint: Vec2 | null = null;
    if (unit.lock !== null) {
      const target = state.units[unit.lock.targetId];
      if (target === undefined || !target.alive) {
        unit.lock = null;
      } else {
        const targetVisible = visibleTo(unit.team, target);
        if (targetVisible) unit.lock.lastKnownPosition = { ...target.pos };
        chasePoint = GAME_CONFIG.locks.hiddenTracking || targetVisible
          ? { ...target.pos }
          : { ...unit.lock.lastKnownPosition };

        // Hold position at standoff range when the target is visible.
        if (
          targetVisible &&
          distance(unit.pos, chasePoint) <=
            GAME_CONFIG.shotRange * GAME_CONFIG.locks.chaseStandoffFraction
        ) {
          chasePoint = null;
          // Still face the target while holding.
          const desired = Math.atan2(target.pos.y - unit.pos.y, target.pos.x - unit.pos.x);
          unit.facingRadians = turnTowards(
            unit.facingRadians,
            desired,
            degToRad(GAME_CONFIG.locks.turnRateDegreesPerSecond) * tickSeconds
          );
        }
      }
    }

    let dx = intent.move.x;
    let dy = intent.move.y;
    const manual = dx !== 0 || dy !== 0;

    if (!manual && chasePoint !== null) {
      const d = distance(unit.pos, chasePoint);
      if (d > 2) {
        dx = (chasePoint.x - unit.pos.x) / d;
        dy = (chasePoint.y - unit.pos.y) / d;
      }
    }

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
      unit.pos = moveCircle(
        unit.pos,
        dx * GAME_CONFIG.playerSpeed * tickSeconds,
        dy * GAME_CONFIG.playerSpeed * tickSeconds,
        GAME_CONFIG.playerRadius,
        MAP.walls
      );
    }

    // Facing: toward the lock's chase direction if locked, else movement.
    const turnStep = degToRad(GAME_CONFIG.locks.turnRateDegreesPerSecond) * tickSeconds;
    if (unit.lock !== null) {
      const target = state.units[unit.lock.targetId];
      if (target !== undefined) {
        const facePoint = GAME_CONFIG.locks.hiddenTracking || visibleTo(unit.team, target)
          ? target.pos
          : unit.lock.lastKnownPosition;
        const desired = Math.atan2(facePoint.y - unit.pos.y, facePoint.x - unit.pos.x);
        unit.facingRadians = turnTowards(unit.facingRadians, desired, turnStep);
      }
    } else if (dx !== 0 || dy !== 0) {
      unit.facingRadians = turnTowards(unit.facingRadians, Math.atan2(dy, dx), turnStep);
    }

    // Vision sampling for the decay window.
    if (t - unit.lastVisionSampleTick >= msToTicks(GAME_CONFIG.visionSampleMs)) {
      unit.visionSamples.push({ pos: { ...unit.pos }, atTick: t });
      unit.lastVisionSampleTick = t;
    }
    const memoryTicks = msToTicks(GAME_CONFIG.visionMemoryMs);
    unit.visionSamples = unit.visionSamples.filter((s) => t - s.atTick <= memoryTicks);
  }

  // 5) Collect valid shots this tick. A lock alone never fires.
  type Pending = { shooterId: string; targetId: string; angleError: number };
  const pending: Pending[] = [];
  const coneRad = degToRad(GAME_CONFIG.locks.attackConeDegrees);

  for (const unit of units) {
    if (!unit.alive || unit.lock === null) continue;
    if (t - unit.lastShotAtTick < msToTicks(GAME_CONFIG.shotCooldownMs)) continue;
    if (t - unit.lock.createdAtTick < msToTicks(GAME_CONFIG.locks.lockAcquireMs)) continue;

    const target = state.units[unit.lock.targetId];
    if (target === undefined || !target.alive) continue;

    const fireable = canFireAtTarget(
      { pos: unit.pos, facingRadians: unit.facingRadians },
      {
        x: target.pos.x,
        y: target.pos.y,
        radius: GAME_CONFIG.playerRadius,
        alive: target.alive,
        targetable: visibleTo(unit.team, target),
      },
      MAP.walls,
      GAME_CONFIG.shotRange,
      coneRad,
      GAME_CONFIG.locks.requireFacingCone
    );
    if (!fireable) continue;

    const desired = Math.atan2(target.pos.y - unit.pos.y, target.pos.x - unit.pos.x);
    pending.push({
      shooterId: unit.id,
      targetId: target.id,
      angleError: Math.abs(angleDelta(unit.facingRadians, desired)),
    });
  }

  // 6) Resolve same-tick shots: closest-to-dead-on wins; a shooter who was
  // killed this tick still fires only if within the trade epsilon of the
  // shot that killed them. Trades possible, rare by design.
  pending.sort((a, b) => a.angleError - b.angleError);
  const epsilonRad = degToRad(GAME_CONFIG.locks.tradeEpsilonDegrees);
  const killedBy = new Map<string, number>(); // unitId -> angleError of killing shot

  for (const shot of pending) {
    const killerError = killedBy.get(shot.shooterId);
    if (killerError !== undefined && shot.angleError - killerError > epsilonRad) continue;

    const shooter = state.units[shot.shooterId];
    const target = state.units[shot.targetId];
    events.push({
      type: 'shot',
      shooterId: shot.shooterId,
      from: { ...shooter.pos },
      to: { ...target.pos },
    });
    if (!killedBy.has(shot.targetId)) killedBy.set(shot.targetId, shot.angleError);
    shooter.lastShotAtTick = t;
    events.push({
      type: 'kill',
      unitId: shot.targetId,
      byId: shot.shooterId,
      reason: 'shot',
      at: { ...target.pos },
    });
  }

  for (const unitId of killedBy.keys()) {
    killUnit(state, unitId, t, events);
  }

  // 7) CTF: grab and capture by proximity.
  for (const unit of units) {
    if (!unit.alive) continue;
    if (
      tryGrabFlag(state.ctf, unit.id, unit.team, unit.pos, MAP.flags, GAME_CONFIG.flagInteractRadius)
    ) {
      const flagTeam: Team = unit.team === 'red' ? 'blue' : 'red';
      events.push({ type: 'flag-grab', byId: unit.id, flagTeam });
    }
    if (
      tryCaptureFlag(
        state.ctf,
        unit.id,
        unit.team,
        unit.pos,
        MAP.flags,
        GAME_CONFIG.flagInteractRadius
      )
    ) {
      events.push({ type: 'flag-capture', byId: unit.id, scoringTeam: unit.team });
    }
  }

  // 8) Anti-camp timers (own flag zone only).
  const graceTicks = msToTicks(GAME_CONFIG.campGraceMs);
  const warningTicks = msToTicks(GAME_CONFIG.campWarningMs);
  const resetTicks = msToTicks(GAME_CONFIG.campResetMs);

  for (const unit of units) {
    if (!unit.alive) continue;
    const ownFlag = MAP.flags.find((flag) => flag.team === unit.team);
    if (ownFlag === undefined) continue;

    const inside =
      distance(unit.pos, { x: ownFlag.x, y: ownFlag.y }) <= ownFlag.campRadius;

    if (inside) {
      if (unit.campStartedTick === null) unit.campStartedTick = t;
      unit.campExitedTick = null;
      if (t - unit.campStartedTick >= graceTicks + warningTicks) {
        events.push({
          type: 'kill',
          unitId: unit.id,
          byId: null,
          reason: 'camping',
          at: { ...unit.pos },
        });
        killUnit(state, unit.id, t, events);
      }
    } else if (unit.campStartedTick !== null) {
      if (unit.campExitedTick === null) unit.campExitedTick = t;
      if (t - unit.campExitedTick >= resetTicks) {
        unit.campStartedTick = null;
        unit.campExitedTick = null;
      }
    }
  }

  // 9) Match end.
  const remainingMs = GAME_CONFIG.roundDurationMs - ticksToMs(t);
  if (evaluateMatch(state.match, state.ctf, remainingMs, GAME_CONFIG.scoreToWin)) {
    events.push({ type: 'match-end', result: state.match.result! });
  }

  return events;
}

function killUnit(state: GameState, unitId: string, tick: number, events: GameEvent[]) {
  const unit = state.units[unitId];
  if (unit === undefined || !unit.alive) return;

  unit.alive = false;
  unit.respawnAtTick = tick + msToTicks(GAME_CONFIG.respawnTimeMs);
  unit.lock = null;
  unit.visionSamples = [];
  unit.campStartedTick = null;
  unit.campExitedTick = null;

  // Locks end when their target dies.
  for (const other of Object.values(state.units)) {
    if (other.lock?.targetId === unitId) other.lock = null;
  }

  // Death sends any carried flag straight home.
  const carried = carriedFlagTeam(state.ctf, unitId);
  if (returnFlagOnDeath(state.ctf, unitId) && carried !== null) {
    events.push({ type: 'flag-return', flagTeam: carried });
  }
}

function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function remainingRoundMs(state: GameState): number {
  return Math.max(0, GAME_CONFIG.roundDurationMs - ticksToMs(state.tick));
}
