// Movement rules. Pure — shared by client and server.

import type { Vec2 } from './geometry';
import { circleIntersectsRect } from './geometry';
import type { WallDef } from './config';

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

