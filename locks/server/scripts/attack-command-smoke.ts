// Slice 4C sticky attack-command smoke test. Proves visible acquisition,
// queued attack execution, last-known pursuit through fog, reacquisition,
// command completion, and deterministic replay without a browser.

import assert from 'node:assert/strict';

import { applyPlayerCommand, createUnitCommandState } from '../../client/src/shared/commands.js';
import { GAME_CONFIG, MAP } from '../../client/src/shared/config.js';
import { distance } from '../../client/src/shared/geometry.js';
import { collidesWithWalls } from '../../client/src/shared/movement.js';
import {
  createGameState,
  IDLE_INTENT,
  isUnitVisibleToTeam,
  step,
} from '../../client/src/shared/state.js';
import { validatePlayerCommand } from '../src/playerCommands.js';

function main() {
  visibleAttackKillsAndCompletes();
  hiddenTargetUsesOnlyLastKnownPosition();
  reacquisitionRefreshesLastKnownPosition();
  deterministicAttackReplay();
  console.log('ATTACK COMMAND SMOKE PASS');
}

function visibleAttackKillsAndCompletes() {
  const state = isolatedState(41);
  const targetPoint = findVisibleOpenPoint(state, 'r1', 180, 40);
  state.units.b1.pos = targetPoint;

  const validated = validatePlayerCommand(state, 'r1', { type: 'attack', targetId: 'b1' });
  assert.ok(validated?.type === 'attack');
  applyPlayerCommand(state.commands.r1, validated!, 'replace');

  for (let tick = 0; tick < 240 && state.units.b1.alive; tick += 1) {
    step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });
  }
  assert.equal(state.units.b1.alive, false, 'visible attack order should eventually fire');

  step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });
  assert.deepEqual(state.commands.r1, createUnitCommandState());
  assert.equal(state.units.r1.lock, null);
}

function hiddenTargetUsesOnlyLastKnownPosition() {
  const state = isolatedState(42);
  const initialVisible = findVisibleOpenPoint(state, 'r1', 280, 30);
  state.units.b1.pos = initialVisible;

  const validated = validatePlayerCommand(state, 'r1', { type: 'attack', targetId: 'b1' });
  assert.ok(validated?.type === 'attack');
  applyPlayerCommand(state.commands.r1, validated!, 'replace');

  const followup = { ...state.units.r1.pos };
  applyPlayerCommand(state.commands.r1, { type: 'move', ...followup }, 'append');

  step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });
  const remembered = { ...initialVisible };
  const hidden = findHiddenOpenPoint(state, 'r1');
  state.units.b1.pos = hidden;
  // A death outside team vision must not reveal itself by cancelling the
  // attack order. The attacker still checks the remembered position.
  state.units.b1.alive = false;
  state.units.b1.respawnAtTick = null;

  for (let tick = 0; tick < 12; tick += 1) {
    step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });
    const active = state.commands.r1.active;
    if (active?.type !== 'attack') throw new Error('attack order ended before last-known pursuit');
    assert.deepEqual(
      active.lastKnownPosition,
      remembered,
      'hidden real position must not update attack steering'
    );
  }

  let sawFollowup = false;
  for (let tick = 0; tick < 900 && state.commands.r1.active !== null; tick += 1) {
    step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });
    if (state.commands.r1.active?.type === 'move') sawFollowup = true;
  }

  assert.equal(sawFollowup, true, 'reaching last-known position should continue queued orders');
  assert.ok(distance(state.units.r1.pos, followup) < 60);
  assert.deepEqual(state.commands.r1, createUnitCommandState());
  assert.ok(distance(hidden, remembered) > GAME_CONFIG.playerVisionRadius * 2);
}

function reacquisitionRefreshesLastKnownPosition() {
  const state = isolatedState(43);
  const initialVisible = findVisibleOpenPoint(state, 'r1', 280, -25);
  state.units.b1.pos = initialVisible;
  const validated = validatePlayerCommand(state, 'r1', { type: 'attack', targetId: 'b1' });
  assert.ok(validated?.type === 'attack');
  applyPlayerCommand(state.commands.r1, validated!, 'replace');
  step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });

  state.units.b1.pos = findHiddenOpenPoint(state, 'r1');
  for (let tick = 0; tick < 5; tick += 1) {
    step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });
  }

  const reacquired = findVisibleOpenPoint(state, 'r1', 300, 0);
  state.units.b1.pos = reacquired;
  state.units.r1.lastShotAtTick = state.tick;
  step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });

  const active = state.commands.r1.active;
  if (active?.type !== 'attack') throw new Error('attack order did not survive reacquisition');
  assert.deepEqual(active.lastKnownPosition, reacquired);
  assert.deepEqual(state.units.r1.lock?.lastKnownPosition, reacquired);
}

function deterministicAttackReplay() {
  const first = isolatedState(44);
  const second = isolatedState(44);
  const target = findVisibleOpenPoint(first, 'r1', 290, 20);

  for (const state of [first, second]) {
    state.units.b1.pos = { ...target };
    const validated = validatePlayerCommand(state, 'r1', {
      type: 'attack',
      targetId: 'b1',
    });
    assert.ok(validated?.type === 'attack');
    applyPlayerCommand(state.commands.r1, validated!, 'replace');
  }

  for (let tick = 0; tick < 120; tick += 1) {
    step(first, { r1: IDLE_INTENT, b1: IDLE_INTENT });
    step(second, { r1: IDLE_INTENT, b1: IDLE_INTENT });
  }

  assert.deepEqual(first.units, second.units);
  assert.deepEqual(first.commands, second.commands);
  assert.deepEqual(first.ctf, second.ctf);
}

function isolatedState(seed: number) {
  const state = createGameState(seed);
  for (const id of ['r2', 'b2']) {
    state.units[id].alive = false;
    state.units[id].respawnAtTick = null;
  }
  return state;
}

function findVisibleOpenPoint(
  state: ReturnType<typeof createGameState>,
  viewerId: string,
  preferredDistance: number,
  yOffset: number
) {
  const viewer = state.units[viewerId];
  for (let ring = 0; ring < 12; ring += 1) {
    for (const sign of [1, -1]) {
      const point = {
        x: viewer.pos.x + preferredDistance - ring * 12,
        y: viewer.pos.y + yOffset + sign * ring * 10,
      };
      if (!isOpen(point.x, point.y)) continue;
      const original = { ...state.units.b1.pos };
      state.units.b1.pos = point;
      const visible = isUnitVisibleToTeam(state, viewer.team, state.units.b1);
      state.units.b1.pos = original;
      if (visible) return point;
    }
  }
  throw new Error('Could not find visible open target point');
}

function findHiddenOpenPoint(state: ReturnType<typeof createGameState>, viewerId: string) {
  const viewer = state.units[viewerId];
  for (let y = GAME_CONFIG.worldHeight - 80; y >= 80; y -= 72) {
    for (let x = GAME_CONFIG.worldWidth - 80; x >= 80; x -= 72) {
      if (!isOpen(x, y)) continue;
      const original = { ...state.units.b1.pos };
      state.units.b1.pos = { x, y };
      const hidden = !isUnitVisibleToTeam(state, viewer.team, state.units.b1);
      state.units.b1.pos = original;
      if (hidden && distance(viewer.pos, { x, y }) > GAME_CONFIG.playerVisionRadius * 2) {
        return { x, y };
      }
    }
  }
  throw new Error('Could not find hidden open target point');
}

function isOpen(x: number, y: number) {
  const radius = GAME_CONFIG.playerRadius;
  return (
    x >= radius &&
    y >= radius &&
    x <= GAME_CONFIG.worldWidth - radius &&
    y <= GAME_CONFIG.worldHeight - radius &&
    !collidesWithWalls(x, y, radius, MAP.walls)
  );
}

main();
