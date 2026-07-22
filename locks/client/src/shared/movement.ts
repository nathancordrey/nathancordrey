// Movement rules. Pure — shared by client and server.

import type { Vec2 } from './geometry';
import { circleIntersectsRect } from './geometry';
import type { WallDef } from './config';

// --- Movement -------------------------------------------------------------

export function collidesWithWalls(x: number, y: number, radius: number, walls: WallDef[]): boolean {
  return walls.some((w) => circleIntersectsRect(x, y, radius, w.rect));
}

// Deterministic conservative segment test used to smooth A* paths. The step
// size is tied to the unit radius, so every caller samples the same points.
export function canTraverseSegment(
  from: Vec2,
  to: Vec2,
  radius: number,
  walls: WallDef[]
): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0) return !collidesWithWalls(to.x, to.y, radius, walls);

  const sampleSpacing = Math.max(2, radius * 0.4);
  const steps = Math.max(1, Math.ceil(length / sampleSpacing));
  for (let index = 1; index <= steps; index += 1) {
    const alpha = index / steps;
    const x = from.x + (to.x - from.x) * alpha;
    const y = from.y + (to.y - from.y) * alpha;
    if (collidesWithWalls(x, y, radius, walls)) return false;
  }
  return true;
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
