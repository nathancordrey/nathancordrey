// Deterministic execution of move and attack travel. A* supplies
// obstacle-avoiding waypoints; the shared simulation owns route progress so
// practice and online play follow the same path tick-for-tick.

import type { Vec2 } from './geometry';
import { distance } from './geometry';
import { GAME_CONFIG, MAP, TILE } from './config';
import type { UnitCommandState } from './commands';
import { completeActiveCommand } from './commands';
import { canTraverseSegment } from './movement';
import { findPath } from './pathfind';

const WAYPOINT_REACHED_RADIUS = Math.max(5, GAME_CONFIG.playerRadius * 0.55);
const COMMAND_COMPLETE_RADIUS = Math.max(5, GAME_CONFIG.playerRadius * 0.45);
const DYNAMIC_GOAL_REPATH_DISTANCE = TILE * 0.5;

export type MoveCommandDirectionResult = {
  direction: Vec2 | null;
  completedCommands: number;
};

export type RouteDirectionResult = {
  direction: Vec2 | null;
  reached: boolean;
};

// Returns the direction for the current move order. Consecutive already-reached
// move commands may be completed in one tick, but the loop is bounded by the
// queue limit so malformed state cannot spin forever.
export function moveCommandDirection(
  commandState: UnitCommandState,
  from: Vec2
): MoveCommandDirectionResult {
  let completedCommands = 0;

  for (let guard = 0; guard <= 10; guard += 1) {
    const active = commandState.active;
    if (active === null || active.type !== 'move') {
      return { direction: null, completedCommands };
    }

    const route = routeDirectionToGoal(commandState, from, { x: active.x, y: active.y }, false);
    if (route.reached) {
      completeActiveCommand(commandState);
      completedCommands += 1;
      continue;
    }
    return { direction: route.direction, completedCommands };
  }

  return { direction: null, completedCommands };
}

// Shared route executor used by sticky attack orders. Dynamic goals replan
// only after moving a meaningful distance, avoiding an A* search every tick
// while still tracking a visible moving target responsively.
export function routeDirectionToGoal(
  commandState: UnitCommandState,
  from: Vec2,
  goal: Vec2,
  dynamicGoal: boolean
): RouteDirectionResult {
  ensurePath(commandState, from, goal, dynamicGoal);

  while (
    commandState.pathIndex < commandState.path.length &&
    distance(from, commandState.path[commandState.pathIndex]) <= WAYPOINT_REACHED_RADIUS
  ) {
    commandState.pathIndex += 1;
  }

  if (commandState.pathIndex >= commandState.path.length) {
    return {
      direction: null,
      reached: distance(from, goal) <= WAYPOINT_REACHED_RADIUS,
    };
  }

  const waypoint = commandState.path[commandState.pathIndex];
  const d = distance(from, waypoint);
  if (d <= COMMAND_COMPLETE_RADIUS) {
    commandState.pathIndex += 1;
    return routeDirectionToGoal(commandState, from, goal, dynamicGoal);
  }

  return {
    direction: {
      x: (waypoint.x - from.x) / d,
      y: (waypoint.y - from.y) / d,
    },
    reached: false,
  };
}

function ensurePath(
  commandState: UnitCommandState,
  from: Vec2,
  goal: Vec2,
  dynamicGoal: boolean
): void {
  const replanDistance = dynamicGoal ? DYNAMIC_GOAL_REPATH_DISTANCE : 0;
  const sameGoal =
    commandState.pathGoal !== null &&
    distance(commandState.pathGoal, goal) <= replanDistance;
  const hasUsablePath = commandState.pathIndex < commandState.path.length;
  if (sameGoal && hasUsablePath) return;
  if (sameGoal && distance(from, goal) <= COMMAND_COMPLETE_RADIUS) return;

  const raw = findPath(from, goal) ?? [];
  const candidates = raw.map((point) => ({ ...point }));

  // A* operates on tile centers. Finish at the exact click/last-known point
  // when the final leg is collision-free; otherwise the nearest reachable
  // grid center is the authoritative endpoint.
  const last = candidates.at(-1) ?? from;
  if (
    distance(last, goal) > COMMAND_COMPLETE_RADIUS &&
    canTraverseSegment(last, goal, GAME_CONFIG.playerRadius, MAP.walls)
  ) {
    candidates.push({ ...goal });
  } else if (candidates.length === 0 && distance(from, goal) > COMMAND_COMPLETE_RADIUS) {
    if (canTraverseSegment(from, goal, GAME_CONFIG.playerRadius, MAP.walls)) {
      candidates.push({ ...goal });
    }
  }

  commandState.path = smoothPath(from, candidates);
  commandState.pathIndex = 0;
  commandState.pathGoal = { ...goal };

  // A valid command can resolve to the current tile center. Keep one exact
  // endpoint when it is safely reachable so short clicks still move.
  if (
    commandState.path.length === 0 &&
    distance(from, goal) > COMMAND_COMPLETE_RADIUS &&
    canTraverseSegment(from, goal, GAME_CONFIG.playerRadius, MAP.walls)
  ) {
    commandState.path = [{ ...goal }];
  }
}

function smoothPath(from: Vec2, candidates: Vec2[]): Vec2[] {
  if (candidates.length <= 1) return candidates;

  const smoothed: Vec2[] = [];
  let anchor = from;
  let nextIndex = 0;

  while (nextIndex < candidates.length) {
    let farthest = nextIndex;
    for (let index = candidates.length - 1; index >= nextIndex; index -= 1) {
      if (canTraverseSegment(anchor, candidates[index], GAME_CONFIG.playerRadius, MAP.walls)) {
        farthest = index;
        break;
      }
    }
    const next = candidates[farthest];
    smoothed.push(next);
    anchor = next;
    nextIndex = farthest + 1;
  }

  return smoothed;
}

// Exported for diagnostics/tests without exposing grid internals elsewhere.
export const WAYPOINT_TOLERANCE = {
  reached: WAYPOINT_REACHED_RADIUS,
  complete: COMMAND_COMPLETE_RADIUS,
  dynamicRepath: DYNAMIC_GOAL_REPATH_DISTANCE,
  tile: TILE,
};
