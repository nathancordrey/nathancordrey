// Bot brains: functions from perceived state to intent. Bots see only what
// their team sees (perception enforces it) and act through the same step()
// rules as humans — no wallhacks possible.
//
// "Bots proper": A*-based travel (getting to a flag and back), seeded
// reaction delays so they're beatable, sweep-last-known when a target is
// lost, and CTF roles (defender / runner) layered over a lock-on-sight
// combat reflex. Difficulty is a BotConfig; one tier now, plumbed for more.

import type { Vec2 } from './geometry';
import { GAME_CONFIG, TILE } from './config';
import type { BotConfig, Team } from './config';
import { findPath } from './pathfind';
import { createRng, randomInt, randomRange } from './rng';
import type { RngState } from './rng';
import type { Intent, PerceivedEnemy, PerceivedState } from './state';
import { IDLE_INTENT } from './state';

export type BotBrain = (view: PerceivedState) => Intent;

export const idleBrain: BotBrain = () => IDLE_INTENT;

export type BotRole = 'defender' | 'runner';

// Static flag home positions (mirror of MAP.flags). Flag locations are public
// information, so brains may know them directly.
const FLAG_HOME: Record<Team, Vec2> = {
  red: { x: 9 * TILE, y: 32 * TILE },
  blue: { x: 55 * TILE, y: 32 * TILE },
};

// Stable per-bot seed: independent jitter per bot, deterministic per match.
function seedFor(botId: string, matchSeed: number): number {
  let h = matchSeed >>> 0;
  for (let i = 0; i < botId.length; i++) {
    h = Math.imul(h ^ botId.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Walk a cached A* path toward a goal, repathing when the goal drifts or the
// path is spent. Returns a movement direction, or null when effectively there.
class Traveler {
  private path: Vec2[] = [];
  private index = 0;
  private goalAtPath: Vec2 | null = null;

  directionTo(from: Vec2, goal: Vec2, cfg: BotConfig): Vec2 | null {
    const repathThreshold = cfg.repathOnGoalMoveTiles * TILE;
    const goalMoved =
      this.goalAtPath === null || distance(this.goalAtPath, goal) > repathThreshold;
    const spent = this.index >= this.path.length;

    if (goalMoved || spent) {
      const fresh = findPath(from, goal);
      if (fresh === null || fresh.length === 0) {
        const d = distance(from, goal);
        if (d < TILE * 0.5) return null;
        return { x: (goal.x - from.x) / d, y: (goal.y - from.y) / d };
      }
      this.path = fresh;
      this.index = 0;
      this.goalAtPath = { ...goal };
    }

    while (this.index < this.path.length && distance(from, this.path[this.index]) < TILE * 0.4) {
      this.index += 1;
    }
    if (this.index >= this.path.length) {
      const d = distance(from, goal);
      if (d < TILE * 0.5) return null;
      return { x: (goal.x - from.x) / d, y: (goal.y - from.y) / d };
    }

    const wp = this.path[this.index];
    const d = distance(from, wp);
    if (d < 1) return null;
    return { x: (wp.x - from.x) / d, y: (wp.y - from.y) / d };
  }

  reset() {
    this.path = [];
    this.index = 0;
    this.goalAtPath = null;
  }
}

export function assignRole(indexInTeam: number): BotRole {
  return indexInTeam === 0 ? 'defender' : 'runner';
}

export function makeBotBrain(
  botId: string,
  role: BotRole,
  cfg: BotConfig = GAME_CONFIG.botDifficulties[GAME_CONFIG.defaultBotDifficulty],
  matchSeed: number = GAME_CONFIG.defaultSeed
): BotBrain {
  const rng: RngState = createRng(seedFor(botId, matchSeed));
  const traveler = new Traveler();
  const tickMs = 1000 / GAME_CONFIG.tickRate;

  let reactAtTick: number | null = null;
  let reactTargetId: string | null = null;
  let sweepPoint: Vec2 | null = null;
  let sweepUntilTick = 0;
  let defenderOrbit: Vec2 | null = null;
  let defenderRepathTick = 0;

  function pickTarget(view: PerceivedState): PerceivedEnemy | null {
    let best: PerceivedEnemy | null = null;
    let bestD = Infinity;
    for (const enemy of view.visibleEnemies) {
      const d = distance(enemy.pos, view.self.pos);
      if (d < bestD) {
        bestD = d;
        best = enemy;
      }
    }
    return best;
  }

  // Returns an Intent if committing to combat this tick, else null.
  function combat(view: PerceivedState): Intent | null {
    const self = view.self;

    if (self.lock !== null) {
      const stillVisible = view.visibleEnemies.some((e) => e.id === self.lock!.targetId);
      if (stillVisible) {
        reactAtTick = null;
        reactTargetId = null;
        return { move: { x: 0, y: 0 } };
      }
      const lastKnown = self.lock.lastKnownPosition;
      sweepPoint = {
        x: lastKnown.x + randomRange(rng, -1, 1) * cfg.sweepJitterTiles * TILE,
        y: lastKnown.y + randomRange(rng, -1, 1) * cfg.sweepJitterTiles * TILE,
      };
      sweepUntilTick = view.tick + randomInt(rng, 30, 60);
      return null;
    }

    const target = pickTarget(view);
    if (target === null) {
      reactAtTick = null;
      reactTargetId = null;
      return null;
    }

    if (reactTargetId !== target.id || reactAtTick === null) {
      reactTargetId = target.id;
      const delayMs = randomRange(rng, cfg.reactionMinMs, cfg.reactionMaxMs);
      reactAtTick = view.tick + Math.round(delayMs / tickMs);
    }

    if (view.tick >= reactAtTick) {
      return { move: { x: 0, y: 0 }, lockTargetId: target.id };
    }
    return null;
  }

  function sweepMovement(view: PerceivedState): Vec2 | null {
    if (sweepPoint === null || view.tick >= sweepUntilTick) {
      sweepPoint = null;
      return null;
    }
    const d = distance(view.self.pos, sweepPoint);
    if (d < TILE * 0.6) {
      sweepPoint = null;
      return null;
    }
    return traveler.directionTo(view.self.pos, sweepPoint, cfg);
  }

  function defenderGoal(view: PerceivedState): Vec2 {
    const home = FLAG_HOME[view.self.team];
    const radius = GAME_CONFIG.ownFlagCampRadius + TILE * 2;
    const angle = randomRange(rng, 0, Math.PI * 2);
    return { x: home.x + Math.cos(angle) * radius, y: home.y + Math.sin(angle) * radius };
  }

  function runnerGoal(view: PerceivedState): Vec2 {
    const enemyTeam: Team = view.self.team === 'red' ? 'blue' : 'red';
    const carrying = view.carrierIds[enemyTeam] === view.self.id;
    return carrying ? FLAG_HOME[view.self.team] : FLAG_HOME[enemyTeam];
  }

  return (view: PerceivedState): Intent => {
    const self = view.self;
    if (!self.alive) {
      traveler.reset();
      reactAtTick = null;
      reactTargetId = null;
      sweepPoint = null;
      return IDLE_INTENT;
    }

    const combatIntent = combat(view);
    if (combatIntent !== null) return combatIntent;
    if (self.lock !== null) return { move: { x: 0, y: 0 } };

    const sweepDir = sweepMovement(view);
    if (sweepDir !== null) return { move: sweepDir };

    let goal: Vec2;
    if (role === 'runner') {
      goal = runnerGoal(view);
    } else {
      if (defenderOrbit === null || view.tick >= defenderRepathTick) {
        defenderOrbit = defenderGoal(view);
        defenderRepathTick = view.tick + randomInt(rng, 90, 180);
      }
      goal = defenderOrbit;
    }

    const dir = traveler.directionTo(self.pos, goal, cfg);
    if (dir === null) return { move: { x: 0, y: 0 } };
    return { move: dir };
  };
}

// Back-compat wrapper: callers that still say makeAggroBrain get a runner.
export function makeAggroBrain(
  botId: string,
  matchSeed: number = GAME_CONFIG.defaultSeed
): BotBrain {
  return makeBotBrain(botId, 'runner', GAME_CONFIG.botDifficulties.normal, matchSeed);
}
