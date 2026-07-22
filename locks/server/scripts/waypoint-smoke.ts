// Slice 4B waypoint execution smoke test. Proves shared A* movement, queued
// destinations, stop semantics, and deterministic replay without a browser.

import assert from 'node:assert/strict';

import { applyPlayerCommand, createUnitCommandState } from '../../client/src/shared/commands.js';
import { GAME_CONFIG } from '../../client/src/shared/config.js';
import { distance } from '../../client/src/shared/geometry.js';
import { createGameState, IDLE_INTENT, step } from '../../client/src/shared/state.js';
import { validatePlayerCommand } from '../src/playerCommands.js';

function main() {
  singleDestinationRoutesAroundCover();
  queuedDestinationsExecuteInOrder();
  stopClearsTravelImmediately();
  deterministicReplay();
  console.log('WAYPOINT SMOKE PASS');
}

function singleDestinationRoutesAroundCover() {
  const state = createGameState(31);
  const start = { ...state.units.r1.pos };
  const goal = findValidOpenPoint(state, 1750, start.y);
  const validated = validatePlayerCommand(state, 'r1', { type: 'move', ...goal });
  assert.ok(validated && validated.type === 'move');
  applyPlayerCommand(state.commands.r1, validated, 'replace');

  runUntilIdle(state, 1200);
  assert.ok(distance(state.units.r1.pos, start) > 700, 'unit should cross a large part of map');
  assert.ok(distance(state.units.r1.pos, goal) < 55, 'unit should finish near clicked destination');
  assert.deepEqual(state.commands.r1, createUnitCommandState());
}

function queuedDestinationsExecuteInOrder() {
  const state = createGameState(32);
  const first = findValidOpenPoint(state, 720, 720);
  const second = findValidOpenPoint(state, 720, 1500);

  applyPlayerCommand(state.commands.r1, { type: 'move', ...first }, 'replace');
  applyPlayerCommand(state.commands.r1, { type: 'move', ...second }, 'append');

  let sawSecondActivate = false;
  for (let tick = 0; tick < 1200 && state.commands.r1.active !== null; tick += 1) {
    step(state, { r1: IDLE_INTENT });
    const active = state.commands.r1.active;
    if (active?.type === 'move' && active.x === second.x && active.y === second.y) {
      sawSecondActivate = true;
    }
  }

  assert.equal(sawSecondActivate, true, 'second queued destination should become active');
  assert.ok(distance(state.units.r1.pos, second) < 55, 'unit should finish at second destination');
  assert.deepEqual(state.commands.r1, createUnitCommandState());
}

function stopClearsTravelImmediately() {
  const state = createGameState(33);
  const goal = findValidOpenPoint(state, 1700, 900);
  applyPlayerCommand(state.commands.r1, { type: 'move', ...goal }, 'replace');
  for (let tick = 0; tick < 30; tick += 1) step(state, { r1: IDLE_INTENT });
  const stoppedAt = { ...state.units.r1.pos };

  applyPlayerCommand(state.commands.r1, { type: 'stop' }, 'replace');
  for (let tick = 0; tick < 30; tick += 1) step(state, { r1: IDLE_INTENT });

  assert.ok(distance(state.units.r1.pos, stoppedAt) < 0.01, 'stop must halt movement');
  assert.deepEqual(state.commands.r1, createUnitCommandState());
}

function deterministicReplay() {
  const first = createGameState(34);
  const second = createGameState(34);
  const points = [
    findValidOpenPoint(first, 760, 760),
    findValidOpenPoint(first, 1000, 1700),
    findValidOpenPoint(first, 1600, 1400),
  ];

  for (const state of [first, second]) {
    applyPlayerCommand(state.commands.r1, { type: 'move', ...points[0] }, 'replace');
    applyPlayerCommand(state.commands.r1, { type: 'move', ...points[1] }, 'append');
    applyPlayerCommand(state.commands.r1, { type: 'move', ...points[2] }, 'append');
  }

  for (let tick = 0; tick < 900; tick += 1) {
    step(first, { r1: IDLE_INTENT });
    step(second, { r1: IDLE_INTENT });
  }

  assert.deepEqual(first.units.r1.pos, second.units.r1.pos);
  assert.deepEqual(first.units.r1.facingRadians, second.units.r1.facingRadians);
  assert.deepEqual(first.commands.r1, second.commands.r1);
}

function runUntilIdle(state: ReturnType<typeof createGameState>, maxTicks: number) {
  for (let tick = 0; tick < maxTicks && state.commands.r1.active !== null; tick += 1) {
    step(state, { r1: IDLE_INTENT });
  }
  assert.equal(state.commands.r1.active, null, `command did not finish within ${maxTicks} ticks`);
}

function findValidOpenPoint(
  state: ReturnType<typeof createGameState>,
  preferredX: number,
  preferredY: number
) {
  const radius = GAME_CONFIG.playerRadius;
  for (let ring = 0; ring < 30; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = Math.max(radius, Math.min(GAME_CONFIG.worldWidth - radius, preferredX + dx * 18));
        const y = Math.max(radius, Math.min(GAME_CONFIG.worldHeight - radius, preferredY + dy * 18));
        if (validatePlayerCommand(state, 'r1', { type: 'move', x, y }) !== null) {
          return { x, y };
        }
      }
    }
  }
  throw new Error('Could not find a valid nearby waypoint');
}

main();
