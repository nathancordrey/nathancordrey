// Combat rules: shots, locks, facing cones, same-tick resolution.
// Pure — shared by client and server.

import type { RayHit, Vec2 } from './geometry';
import { distance, segmentCircleIntersection, segmentRectIntersection } from './geometry';
import type { WallDef } from './config';
import { nearestWallHit } from './vision';

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

// Locks mode: the shot is a click ON the enemy. Returns the index of the
// clicked target, or null. Misclicks on empty ground are not shots.
export function findClickedTarget(
  clickPoint: Vec2,
  targets: CircleTarget[],
  tolerance: number
): number | null {
  let best: { index: number; d: number } | null = null;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (!target.alive) continue;
    const d = distance(clickPoint, { x: target.x, y: target.y });
    if (d <= target.radius + tolerance && (!best || d < best.d)) {
      best = { index: i, d };
    }
  }
  return best?.index ?? null;
}

export type LockShotVerdict = 'hit' | 'no-vision' | 'out-of-range';

// Validate a lock-on shot: needs team vision of the target and range.
// Guaranteed hit when valid — no aim-miss in locks mode.
export function verifyLockShot(
  origin: Vec2,
  target: CircleTarget,
  range: number
): LockShotVerdict {
  if (target.targetable === false) return 'no-vision';
  if (distance(origin, { x: target.x, y: target.y }) > range) return 'out-of-range';
  return 'hit';
}

// --- Lock orders: facing, cones, and fire validation ----------------------
// A lock is a sticky attack/chase order, not an instant shot. Movement may
// track a hidden target (hiddenTracking), but firing requires the full set
// of simulation conditions below. See design note 2026-07-17.

export type LockOrder = {
  targetIndex: number;
  createdAt: number;
  lastVisibleAt: number | null;
  lastKnownPosition: Vec2 | null;
};

// Signed smallest difference between two angles, in [-PI, PI].
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

// Rotate `current` toward `desired` by at most `maxStep` radians.
export function turnTowards(current: number, desired: number, maxStep: number): number {
  const delta = angleDelta(current, desired);
  if (Math.abs(delta) <= maxStep) return desired;
  return current + Math.sign(delta) * maxStep;
}

// Bullet path: only hard walls block shots (soft cover does not).
export function hasClearBulletPath(a: Vec2, b: Vec2, walls: WallDef[]): boolean {
  for (const w of walls) {
    if (!w.blocksShots) continue;
    if (segmentRectIntersection(a, b, w.rect) !== null) return false;
  }
  return true;
}

export type ShooterState = { pos: Vec2; facingRadians: number };

// A lock may exist without any of this being true. Firing requires ALL of:
// alive target, team vision (current or lingering — expressed via
// `targetable`), weapon range, clear bullet path, and (optionally) the
// target inside the shooter's attack cone. Cooldown and lock-acquire time
// are checked by the caller, which owns the clock.
export function canFireAtTarget(
  shooter: ShooterState,
  target: CircleTarget,
  walls: WallDef[],
  range: number,
  attackConeRadians: number,
  requireFacingCone: boolean
): boolean {
  if (!target.alive) return false;
  if (target.targetable === false) return false;

  const targetPos: Vec2 = { x: target.x, y: target.y };
  if (distance(shooter.pos, targetPos) > range) return false;
  if (!hasClearBulletPath(shooter.pos, targetPos, walls)) return false;

  if (requireFacingCone) {
    const desired = Math.atan2(targetPos.y - shooter.pos.y, targetPos.x - shooter.pos.x);
    if (Math.abs(angleDelta(shooter.facingRadians, desired)) > attackConeRadians / 2) {
      return false;
    }
  }

  return true;
}

// --- Simultaneous shot resolution -----------------------------------------
// When two (or more) shooters validate a shot on the SAME simulation tick,
// the one whose facing is closest to dead-on wins. If the best two are
// within tradeEpsilonRadians of each other, both shots land (a true trade —
// rare by design). Not exercised until enemies/other players can shoot.

export type PendingShot = {
  shooterId: string;
  angleErrorRadians: number; // |angleDelta(facing, direction to target)|
};

export function resolveSimultaneousShots(
  shots: PendingShot[],
  tradeEpsilonRadians: number
): string[] {
  if (shots.length <= 1) return shots.map((s) => s.shooterId);

  const sorted = [...shots].sort((a, b) => a.angleErrorRadians - b.angleErrorRadians);
  const best = sorted[0];

  return sorted
    .filter((s) => s.angleErrorRadians - best.angleErrorRadians <= tradeEpsilonRadians)
    .map((s) => s.shooterId);
}
