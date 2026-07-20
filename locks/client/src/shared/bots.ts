// Bot brains: functions from perceived state to intent. Bots see only what
// their team sees (the perception filter enforces this) and act through the
// exact same step() rules as human players.
//
// The aggro brain is the roadmap's minimal solo-playtest tool: patrol
// waypoints, lock anything seen, let the lock system do the rest. Reaction
// delays (seeded RNG) and CTF roles come with "bots proper" post-server.

import type { Vec2 } from './geometry';
import { TILE } from './config';
import type { Intent, PerceivedState } from './state';
import { IDLE_INTENT } from './state';

export type BotBrain = (view: PerceivedState) => Intent;

export const idleBrain: BotBrain = () => IDLE_INTENT;

// Patrol loops per bot, in open ground on the blue half / midfield.
const PATROLS: Record<string, Vec2[]> = {
  r1: [
    { x: 20 * TILE, y: 20 * TILE },
    { x: 29 * TILE, y: 21 * TILE },
    { x: 24 * TILE, y: 28 * TILE },
  ],
  r2: [
    { x: 20 * TILE, y: 44 * TILE },
    { x: 28 * TILE, y: 44 * TILE },
    { x: 21 * TILE, y: 36 * TILE },
  ],
  b1: [
    { x: 44 * TILE, y: 20 * TILE },
    { x: 35 * TILE, y: 21 * TILE },
    { x: 40 * TILE, y: 28 * TILE },
  ],
  b2: [
    { x: 44 * TILE, y: 44 * TILE },
    { x: 36 * TILE, y: 44 * TILE },
    { x: 43 * TILE, y: 36 * TILE },
  ],
};

const WAYPOINT_REACHED = 40;

// Brains may hold instance state (like a human holds a plan); determinism
// requirements apply to step(), and intents are inputs to it.
export function makeAggroBrain(botId: string): BotBrain {
  const patrol = PATROLS[botId] ?? [];
  let waypointIndex = 0;

  return (view: PerceivedState): Intent => {
    const self = view.self;

    // See someone? Lock the nearest — but only issue the order once, or the
    // re-issue would reset the lock's acquire timer every tick.
    if (view.visibleEnemies.length > 0 && self.lock === null) {
      let nearestId = view.visibleEnemies[0].id;
      let nearestDistance = Infinity;
      for (const enemy of view.visibleEnemies) {
        const d = Math.hypot(enemy.pos.x - self.pos.x, enemy.pos.y - self.pos.y);
        if (d < nearestDistance) {
          nearestDistance = d;
          nearestId = enemy.id;
        }
      }
      return { move: { x: 0, y: 0 }, lockTargetId: nearestId };
    }

    // Locked: no manual movement — the lock's chase drives us.
    if (self.lock !== null) {
      return { move: { x: 0, y: 0 } };
    }

    // Otherwise patrol.
    if (patrol.length === 0) return IDLE_INTENT;

    const waypoint = patrol[waypointIndex];
    const dx = waypoint.x - self.pos.x;
    const dy = waypoint.y - self.pos.y;
    const d = Math.hypot(dx, dy);

    if (d <= WAYPOINT_REACHED) {
      waypointIndex = (waypointIndex + 1) % patrol.length;
      return { move: { x: 0, y: 0 } };
    }

    return { move: { x: dx / d, y: dy / d } };
  };
}
