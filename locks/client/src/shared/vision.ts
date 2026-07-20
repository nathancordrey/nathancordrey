// Vision rules: line of sight, fog polygons, vision-with-memory.
// Lingering vision is real vision. Pure — shared by client and server.

import type { RayHit, Vec2 } from './geometry';
import { distance, segmentRectIntersection } from './geometry';
import type { FlagDef, Team, WallDef } from './config';

// --- Raycasts -------------------------------------------------------------

export function nearestWallHit(
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

// --- Vision memory & lock-on fire ----------------------------------------

// A target is in team vision if ANY recent viewpoint (current or from the
// vision-decay window) has line of sight to it — lingering vision is real
// vision — or if it's inside the team's flag beacon.
export function isTargetVisibleFromAny(
  viewpoints: Vec2[],
  viewerTeam: Team,
  target: Vec2,
  walls: WallDef[],
  visionRadius: number,
  flags: FlagDef[]
): boolean {
  for (const viewpoint of viewpoints) {
    if (
      distance(viewpoint, target) <= visionRadius &&
      hasLineOfSight(viewpoint, target, walls)
    ) {
      return true;
    }
  }

  for (const flag of flags) {
    if (flag.team !== viewerTeam) continue;
    if (distance({ x: flag.x, y: flag.y }, target) <= flag.visionRadius) return true;
  }

  return false;
}

