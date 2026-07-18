// Pure simulation rules — no Phaser. This is the code an authoritative
// server will run verbatim to validate movement, shots, and visibility.

import type { RayHit, Vec2 } from './geometry';
import {
  circleIntersectsRect,
  distance,
  segmentCircleIntersection,
  segmentRectIntersection,
} from './geometry';
import type { FlagDef, Team, WallDef } from './config';

export type CircleTarget = {
  x: number;
  y: number;
  radius: number;
  alive: boolean;
  // SC rule: you can only hit what your team has vision of.
  // Defaults to true when omitted.
  targetable?: boolean;
};

export type ShotResult = {
  start: Vec2;
  end: Vec2;
  hitIndex: number | null;
};

// --- Movement -------------------------------------------------------------

export function collidesWithWalls(x: number, y: number, radius: number, walls: WallDef[]): boolean {
  return walls.some((w) => circleIntersectsRect(x, y, radius, w.rect));
}

// Per-axis movement so players slide along walls instead of sticking.
export function moveCircle(
  pos: Vec2,
  dx: number,
  dy: number,
  radius: number,
  walls: WallDef[]
): Vec2 {
  let { x, y } = pos;
  if (!collidesWithWalls(x + dx, y, radius, walls)) x += dx;
  if (!collidesWithWalls(x, y + dy, radius, walls)) y += dy;
  return { x, y };
}

// --- Raycasts -------------------------------------------------------------

function nearestWallHit(
  start: Vec2,
  end: Vec2,
  walls: WallDef[],
  filter: (w: WallDef) => boolean
): RayHit | null {
  let nearest: RayHit | null = null;
  for (const w of walls) {
    if (!filter(w)) continue;
    const hit = segmentRectIntersection(start, end, w.rect);
    if (hit && (!nearest || hit.t < nearest.t)) nearest = hit;
  }
  return nearest;
}

// Vision: every wall blocks sight (soft cover hides you).
export function hasLineOfSight(a: Vec2, b: Vec2, walls: WallDef[]): boolean {
  return nearestWallHit(a, b, walls, () => true) === null;
}

// --- Shooting -------------------------------------------------------------

// Shots pass through soft cover; only blocksShots walls stop them.
export function resolveShot(
  origin: Vec2,
  aimAt: Vec2,
  range: number,
  walls: WallDef[],
  targets: CircleTarget[]
): ShotResult {
  const angle = Math.atan2(aimAt.y - origin.y, aimAt.x - origin.x);
  const maxEnd: Vec2 = {
    x: origin.x + Math.cos(angle) * range,
    y: origin.y + Math.sin(angle) * range,
  };

  const wallHit = nearestWallHit(origin, maxEnd, walls, (w) => w.blocksShots);
  const blockedEnd = wallHit?.point ?? maxEnd;

  let nearest: { index: number; hit: RayHit } | null = null;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (!target.alive) continue;
    if (target.targetable === false) continue;
    const hit = segmentCircleIntersection(
      origin,
      blockedEnd,
      { x: target.x, y: target.y },
      target.radius
    );
    if (hit && (!nearest || hit.t < nearest.hit.t)) nearest = { index: i, hit };
  }

  if (nearest) {
    return { start: origin, end: nearest.hit.point, hitIndex: nearest.index };
  }
  return { start: origin, end: blockedEnd, hitIndex: null };
}

// --- Visibility -----------------------------------------------------------

// A target is visible to a viewer if:
//   (a) it's within the viewer's vision radius AND has clear line of sight, or
//   (b) it's inside the viewer team's flag beacon radius (beacon vision
//       ignores walls — the flag acts as a watchtower, like the original).
export function isTargetVisible(
  viewer: Vec2,
  viewerTeam: Team,
  target: Vec2,
  walls: WallDef[],
  visionRadius: number,
  flags: FlagDef[]
): boolean {
  if (distance(viewer, target) <= visionRadius && hasLineOfSight(viewer, target, walls)) {
    return true;
  }

  for (const flag of flags) {
    if (flag.team !== viewerTeam) continue;
    if (distance({ x: flag.x, y: flag.y }, target) <= flag.visionRadius) return true;
  }

  return false;
}

// --- Vision polygon (fog of war) -----------------------------------------

// Raycast to every wall corner (± epsilon) plus uniform sweep rays, capped at
// the vision radius. Returns points sorted by angle — fill it as a polygon to
// get the lit area. Pure, so the server can reuse it for interest management.
export function computeVisionPolygon(viewer: Vec2, walls: WallDef[], radius: number): Vec2[] {
  const angles: number[] = [];

  for (const w of walls) {
    const { left, top, right, bottom } = w.rect;
    const corners: Vec2[] = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
    for (const corner of corners) {
      const angle = Math.atan2(corner.y - viewer.y, corner.x - viewer.x);
      angles.push(angle - 0.0005, angle, angle + 0.0005);
    }
  }

  const SWEEP_RAYS = 72;
  for (let i = 0; i < SWEEP_RAYS; i++) {
    angles.push((i / SWEEP_RAYS) * Math.PI * 2 - Math.PI);
  }

  angles.sort((a, b) => a - b);

  const points: Vec2[] = [];
  for (const angle of angles) {
    const end: Vec2 = {
      x: viewer.x + Math.cos(angle) * radius,
      y: viewer.y + Math.sin(angle) * radius,
    };
    const hit = nearestWallHit(viewer, end, walls, () => true);
    points.push(hit ? hit.point : end);
  }

  return points;
}

// --- Capture the flag -----------------------------------------------------
// Rules (per the original SC maps): the carrier is NOT revealed and shoots
// normally. Death returns the flag straight home — no dropped-flag state.
// Score by carrying the enemy flag into your own flag zone.

export type CtfFlagState = { atBase: boolean; carrierId: string | null };

export type CtfState = {
  flags: Record<Team, CtfFlagState>;
  scores: Record<Team, number>;
};

export function createCtfState(): CtfState {
  return {
    flags: {
      red: { atBase: true, carrierId: null },
      blue: { atBase: true, carrierId: null },
    },
    scores: { red: 0, blue: 0 },
  };
}

export function carriedFlagTeam(state: CtfState, playerId: string): Team | null {
  for (const team of Object.keys(state.flags) as Team[]) {
    if (state.flags[team].carrierId === playerId) return team;
  }
  return null;
}

// Touch the enemy flag while it's home to pick it up.
export function tryGrabFlag(
  state: CtfState,
  playerId: string,
  playerTeam: Team,
  playerPos: Vec2,
  flags: FlagDef[],
  grabRadius: number
): boolean {
  if (carriedFlagTeam(state, playerId) !== null) return false;

  for (const flag of flags) {
    if (flag.team === playerTeam) continue;
    const flagState = state.flags[flag.team];
    if (!flagState.atBase || flagState.carrierId !== null) continue;
    if (distance(playerPos, { x: flag.x, y: flag.y }) <= grabRadius) {
      flagState.atBase = false;
      flagState.carrierId = playerId;
      return true;
    }
  }
  return false;
}

// Carry the enemy flag into your own flag zone to score; flag returns home.
export function tryCaptureFlag(
  state: CtfState,
  playerId: string,
  playerTeam: Team,
  playerPos: Vec2,
  flags: FlagDef[],
  captureRadius: number
): boolean {
  const carried = carriedFlagTeam(state, playerId);
  if (carried === null || carried === playerTeam) return false;

  const ownFlag = flags.find((flag) => flag.team === playerTeam);
  if (!ownFlag) return false;

  if (distance(playerPos, { x: ownFlag.x, y: ownFlag.y }) <= captureRadius) {
    state.flags[carried] = { atBase: true, carrierId: null };
    state.scores[playerTeam] += 1;
    return true;
  }
  return false;
}

// Death sends any carried flag straight home.
export function returnFlagOnDeath(state: CtfState, playerId: string): boolean {
  const carried = carriedFlagTeam(state, playerId);
  if (carried === null) return false;
  state.flags[carried] = { atBase: true, carrierId: null };
  return true;
}

// --- Match timer & win condition -----------------------------------------
// First to scoreToWin caps wins. If the clock runs out first, higher score
// wins; equal scores = draw.

export type MatchResult = Team | 'draw';

export type MatchState = {
  phase: 'playing' | 'ended';
  result: MatchResult | null;
};

export function createMatchState(): MatchState {
  return { phase: 'playing', result: null };
}

// Returns true if this call ended the match.
export function evaluateMatch(
  match: MatchState,
  ctf: CtfState,
  remainingMs: number,
  scoreToWin: number
): boolean {
  if (match.phase === 'ended') return false;

  for (const team of Object.keys(ctf.scores) as Team[]) {
    if (ctf.scores[team] >= scoreToWin) {
      match.phase = 'ended';
      match.result = team;
      return true;
    }
  }

  if (remainingMs <= 0) {
    match.phase = 'ended';
    if (ctf.scores.red > ctf.scores.blue) match.result = 'red';
    else if (ctf.scores.blue > ctf.scores.red) match.result = 'blue';
    else match.result = 'draw';
    return true;
  }

  return false;
}
