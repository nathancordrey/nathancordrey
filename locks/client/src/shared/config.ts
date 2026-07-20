// Tuning constants + map definition. Shared by client and future server.
// Scale is anchored to the original: 1 SC tile = 36px here.
// Original Snipers Bald Locks maps: 64x64 tiles, ghost sight 9, attack 7,
// viewport ~20x12 tiles.

import type { Rect } from './geometry';
import { rectFromCenter } from './geometry';

export const TILE = 36;

export const GAME_CONFIG = {
  // 64x64-tile world, square like the original.
  worldWidth: 64 * TILE, // 2304
  worldHeight: 64 * TILE, // 2304

  // Camera viewport: ~20x12 tiles, matching the BW screen.
  viewportWidth: 20 * TILE, // 720
  viewportHeight: 12 * TILE, // 432

  // Fixed simulation timestep. Rendering interpolates between ticks.
  tickRate: 30,

  playerSpeed: 180,
  playerRadius: 14,

  // Ghost sight range: 9 tiles.
  playerVisionRadius: 9 * TILE, // 324
  lastSeenLingerMs: 1500,
  // SC-style vision decay: ground you saw stays dimly revealed briefly
  // after you move on, then fog re-covers it.
  visionMemoryMs: 900,
  visionSampleMs: 120,

  shotCooldownMs: 600,
  // Ghost attack range: 7 tiles — you can see farther than you can shoot.
  shotRange: 7 * TILE, // 252


  flagVisionRadius: 9 * TILE,
  ownFlagCampRadius: 10.5 * TILE,
  campGraceMs: 10_000,
  campWarningMs: 3_000,
  campResetMs: 4_000,
  respawnTimeMs: 2_500,

  mobileJoystickMaxDistance: 60,

  flagInteractRadius: 38,

  roundDurationMs: 5 * 60_000,
  scoreToWin: 3,

  // Targeting mode. 'locks' (the intended game): clicking an enemy issues a
  // sticky attack/chase order; firing auto-resolves from sim conditions.
  // 'raycast': free-fire hitscan toward the click point (debug/test mode).
  targetingMode: 'locks' as 'locks' | 'raycast',
  lockClickTolerance: 8,

  locks: {
    // Stale locks keep chasing the target's REAL hidden position (Option B
    // from the design note). Set false to chase last-known position instead.
    hiddenTracking: true,
    requireFacingCone: true,
    attackConeDegrees: 25,
    turnRateDegreesPerSecond: 360,
    lockAcquireMs: 100,
    // Stop closing distance once this fraction of weapon range is reached
    // and the target is visible.
    chaseStandoffFraction: 0.9,
    // Same-tick duels: closest-to-dead-on aim wins; within epsilon = trade.
    tradeEpsilonDegrees: 1.5,
  },

  // Match roster. A unit is a unit — 'player' intents come from input,
  // 'bot' intents come from a brain function, and later 'remote' from a
  // socket. Blue spawns sit outside their own camp zone.
  roster: [
    { id: 'p1', team: 'red' as Team, control: 'player' as const, label: 'YOU', spawn: { x: 12.5 * TILE, y: 32 * TILE } },
    { id: 'b1', team: 'blue' as Team, control: 'bot' as const, label: 'B1', spawn: { x: 44 * TILE, y: 20 * TILE } },
    { id: 'b2', team: 'blue' as Team, control: 'bot' as const, label: 'B2', spawn: { x: 42 * TILE, y: 32 * TILE } },
    { id: 'b3', team: 'blue' as Team, control: 'bot' as const, label: 'B3', spawn: { x: 44 * TILE, y: 44 * TILE } },
  ],
};

export type Team = 'red' | 'blue';

export type WallDef = {
  rect: Rect;
  // Hard walls stop bullets. Soft cover only blocks vision + movement —
  // you can be shot straight through it if the enemy team sees you.
  blocksShots: boolean;
};

export type FlagDef = {
  team: Team;
  x: number;
  y: number;
  visionRadius: number;
  campRadius: number;
};

export type MapDef = {
  walls: WallDef[];
  flags: FlagDef[];
};

function wall(x: number, y: number, w: number, h: number, blocksShots: boolean): WallDef {
  return { rect: rectFromCenter(x, y, w, h), blocksShots };
}

const W = GAME_CONFIG.worldWidth;
const H = GAME_CONFIG.worldHeight;

// Interior layout is defined for one half and mirrored through the map
// center (180° rotational symmetry) so both teams get identical terrain.
const halfLayout: Array<{ x: number; y: number; w: number; h: number; hard: boolean }> = [
  // Hard structures
  { x: 1152, y: 1152, w: 48, h: 420, hard: true }, // center spine
  { x: 1152, y: 640, w: 320, h: 40, hard: true }, // north crossbar
  { x: 620, y: 480, w: 40, h: 280, hard: true }, // NW bunker wall
  { x: 560, y: 1620, w: 260, h: 40, hard: true }, // SW bunker wall

  // Soft cover (foliage)
  { x: 420, y: 780, w: 200, h: 30, hard: false },
  { x: 760, y: 1050, w: 30, h: 220, hard: false },
  { x: 900, y: 700, w: 170, h: 30, hard: false },
  { x: 980, y: 1500, w: 220, h: 30, hard: false },
  { x: 380, y: 1750, w: 30, h: 200, hard: false },
  { x: 640, y: 1900, w: 180, h: 30, hard: false },
  { x: 1100, y: 320, w: 200, h: 30, hard: false },
  { x: 1050, y: 1950, w: 30, h: 190, hard: false },
];

const interiorWalls: WallDef[] = [];
for (const item of halfLayout) {
  interiorWalls.push(wall(item.x, item.y, item.w, item.h, item.hard));
  // Mirror through the center point.
  interiorWalls.push(wall(W - item.x, H - item.y, item.w, item.h, item.hard));
}

export const MAP: MapDef = {
  walls: [
    // Map border — hard walls.
    wall(W / 2, 12, W, 24, true),
    wall(W / 2, H - 12, W, 24, true),
    wall(12, H / 2, 24, H, true),
    wall(W - 12, H / 2, 24, H, true),
    ...interiorWalls,
  ],
  flags: [
    {
      team: 'red',
      x: 9 * TILE,
      y: 32 * TILE,
      visionRadius: GAME_CONFIG.flagVisionRadius,
      campRadius: GAME_CONFIG.ownFlagCampRadius,
    },
    {
      team: 'blue',
      x: 55 * TILE,
      y: 32 * TILE,
      visionRadius: GAME_CONFIG.flagVisionRadius,
      campRadius: GAME_CONFIG.ownFlagCampRadius,
    },
  ],
};

// Dev guardrail: interior structures must stay out of base vision zones so
// both flag areas are open ground. Borders (first 4 walls) are exempt.
for (const flag of MAP.flags) {
  for (const w of MAP.walls.slice(4)) {
    const cx = Math.max(w.rect.left, Math.min(flag.x, w.rect.right));
    const cy = Math.max(w.rect.top, Math.min(flag.y, w.rect.bottom));
    const d = Math.hypot(flag.x - cx, flag.y - cy);
    if (d < flag.visionRadius) {
      console.warn(
        `[map] wall inside ${flag.team} base vision zone (distance ${d.toFixed(0)} < ${flag.visionRadius})`
      );
    }
  }
}
