// Tuning constants + map definition. Shared by client and future server.

import type { Rect } from './geometry';
import { rectFromCenter } from './geometry';

export const GAME_CONFIG = {
  worldWidth: 960,
  worldHeight: 640,

  playerSpeed: 180,
  playerRadius: 14,
  playerSpawnX: 140,
  playerSpawnY: 320,

  // Vision: how far a sniper can see with clear line of sight.
  playerVisionRadius: 330,
  // How long a "last seen" ghost marker lingers after losing sight.
  lastSeenLingerMs: 1500,

  shotCooldownMs: 600,
  shotRange: 900,

  targetRadius: 13,
  targetRespawnMs: 2000,

  flagVisionRadius: 325,
  ownFlagCampRadius: 375,
  campGraceMs: 10_000,
  campWarningMs: 3_000,
  campResetMs: 4_000,
  respawnTimeMs: 2_500,

  mobileJoystickMaxDistance: 60,
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

export type EnemySpawn = { x: number; y: number; label: string };

export type MapDef = {
  walls: WallDef[];
  flags: FlagDef[];
  enemySpawns: EnemySpawn[];
};

function wall(x: number, y: number, w: number, h: number, blocksShots: boolean): WallDef {
  return { rect: rectFromCenter(x, y, w, h), blocksShots };
}

export const MAP: MapDef = {
  walls: [
    // Map border — hard walls, nothing gets through.
    wall(480, 90, 760, 24, true),
    wall(480, 550, 760, 24, true),
    wall(90, 320, 24, 460, true),
    wall(870, 320, 24, 460, true),

    // Center pillar — one hard structure to anchor rotations.
    wall(480, 320, 32, 160, true),

    // Soft cover: blocks vision and walking, but bullets pass through.
    wall(350, 245, 180, 28, false),
    wall(610, 395, 180, 28, false),
    wall(300, 450, 110, 26, false),
    wall(660, 190, 110, 26, false),
  ],
  flags: [
    {
      team: 'red',
      x: 160,
      y: 320,
      visionRadius: GAME_CONFIG.flagVisionRadius,
      campRadius: GAME_CONFIG.ownFlagCampRadius,
    },
    {
      team: 'blue',
      x: 800,
      y: 320,
      visionRadius: GAME_CONFIG.flagVisionRadius,
      campRadius: GAME_CONFIG.ownFlagCampRadius,
    },
  ],
  enemySpawns: [
    { x: 720, y: 250, label: 'T1' },
    { x: 560, y: 430, label: 'T2' },
    { x: 380, y: 190, label: 'T3' },
  ],
};
