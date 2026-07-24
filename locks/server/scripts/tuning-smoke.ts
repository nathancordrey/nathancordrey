import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGameState, isUnitVisibleToTeam, step } from '../../client/src/shared/state.js';

import {
  loadGameplayConfigForNewRoom,
  readGameplayConfig,
  validateGameplayConfigDocument,
} from '../src/gameplayConfig.js';

const directory = mkdtempSync(join(tmpdir(), 'locks-tuning-'));
const path = join(directory, 'gameplay.json');

const valid = {
  activePreset: 'wide',
  presets: {
    baseline: {
      cameraZoom: 1,
      playerVisionRadius: 324,
      shotRange: 252,
      lockAcquireMs: 100,
      playerSpeed: 180,
      respawnTimeMs: 2500,
    },
    wide: {
      cameraZoom: 0.8,
      playerVisionRadius: 396,
      shotRange: 252,
      lockAcquireMs: 650,
      playerSpeed: 180,
      respawnTimeMs: 2500,
    },
  },
};

writeFileSync(path, JSON.stringify(valid));
const loaded = readGameplayConfig(path);
assert(loaded.active.presetName === 'wide', 'active preset');
assert(loaded.active.cameraZoom === 0.8, 'camera zoom');
assert(loaded.active.configHash.length === 12, 'config hash');

// Per-room values are frozen into GameState and affect deterministic shared
// simulation rather than only client presentation.
const baselineState = createGameState(1, valid.presets.baseline);
const wideState = createGameState(1, valid.presets.wide);
baselineState.units.r1.pos = { x: 300, y: 300 };
baselineState.units.b1.pos = { x: 650, y: 300 };
wideState.units.r1.pos = { x: 300, y: 300 };
wideState.units.b1.pos = { x: 650, y: 300 };
assert(!isUnitVisibleToTeam(baselineState, 'red', baselineState.units.b1), 'baseline vision');
assert(isUnitVisibleToTeam(wideState, 'red', wideState.units.b1), 'wide vision');

const slowState = createGameState(1, { ...valid.presets.baseline, playerSpeed: 90 });
const fastState = createGameState(1, { ...valid.presets.baseline, playerSpeed: 180 });
const slowStart = slowState.units.r1.pos.x;
const fastStart = fastState.units.r1.pos.x;
step(slowState, { r1: { move: { x: 1, y: 0 } } });
step(fastState, { r1: { move: { x: 1, y: 0 } } });
const slowDistance = slowState.units.r1.pos.x - slowStart;
const fastDistance = fastState.units.r1.pos.x - fastStart;
assert(Math.abs(fastDistance - slowDistance * 2) < 0.001, 'per-room movement speed');

let rejected = false;
try {
  validateGameplayConfigDocument({
    ...valid,
    presets: {
      bad: {
        ...valid.presets.wide,
        shotRange: 500,
        playerVisionRadius: 300,
      },
    },
    activePreset: 'bad',
  });
} catch {
  rejected = true;
}
assert(rejected, 'range relationship validation');

process.env.GAMEPLAY_CONFIG_PATH = path;
const first = loadGameplayConfigForNewRoom();
writeFileSync(path, '{ broken json');
const fallback = loadGameplayConfigForNewRoom();
assert(fallback.active.configHash === first.active.configHash, 'last-valid fallback');

console.log('TUNING SMOKE PASS');

function assert(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error(`TUNING SMOKE FAIL: ${label}`);
}
