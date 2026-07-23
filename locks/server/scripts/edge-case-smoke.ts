// Slice 4F edge-case smoke test. Exercises command-buffer precedence,
// visible/hidden death knowledge, queued invalidation, match-end cleanup, and
// stale-snapshot rejection without a browser.

import assert from 'node:assert/strict';

import {
  applyPlayerCommand,
  createUnitCommandState,
  removeAttackCommandsTargeting,
} from '../../client/src/shared/commands.js';
import { GAME_CONFIG, MAP } from '../../client/src/shared/config.js';
import { collidesWithWalls } from '../../client/src/shared/movement.js';
import { shouldAcceptSnapshotTick } from '../../client/src/snapshotGuard.js';
import {
  createGameState,
  IDLE_INTENT,
  isUnitVisibleToTeam,
  msToTicks,
  step,
} from '../../client/src/shared/state.js';
import {
  bufferPendingPlayerCommand,
  sanitizePlayerCommandMessage,
  validatePlayerCommand,
} from '../src/playerCommands.js';

function main() {
  commandBufferPrecedence();
  knownDeathRemovesAllTargetOrders();
  visibleCampingDeathCompletesOrders();
  hiddenCampingDeathPreservesLastKnownOrder();
  matchEndClearsCommandsAndLocks();
  snapshotTicksNeverRollBackward();
  console.log('EDGE CASE SMOKE PASS');
}

function commandBufferPrecedence() {
  const pending = [] as NonNullable<ReturnType<typeof sanitizePlayerCommandMessage>>[];
  const append1 = parsed({ command: { type: 'move', x: 400, y: 400 }, queue: true, requestId: 1 });
  const append2 = parsed({ command: { type: 'move', x: 500, y: 400 }, queue: true, requestId: 2 });
  assert.equal(bufferPendingPlayerCommand(pending, append1, 2).buffered, true);
  assert.equal(bufferPendingPlayerCommand(pending, append2, 2).buffered, true);

  const overflow = parsed({ command: { type: 'move', x: 600, y: 400 }, queue: true, requestId: 3 });
  assert.deepEqual(bufferPendingPlayerCommand(pending, overflow, 2), {
    buffered: false,
    superseded: [],
    reason: 'input-buffer-full',
  });

  const stop = parsed({ command: { type: 'stop' }, queue: true, requestId: 4 });
  const stopped = bufferPendingPlayerCommand(pending, stop, 2);
  assert.equal(stopped.buffered, true);
  assert.deepEqual(stopped.superseded.map((entry) => entry.requestId), [1, 2]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].command.type, 'stop');

  const replace = parsed({ command: { type: 'move', x: 700, y: 400 }, queue: false, requestId: 5 });
  const replaced = bufferPendingPlayerCommand(pending, replace, 2);
  assert.deepEqual(replaced.superseded.map((entry) => entry.requestId), [4]);
  assert.deepEqual(pending, [replace]);
}

function knownDeathRemovesAllTargetOrders() {
  const commands = createUnitCommandState();
  applyPlayerCommand(
    commands,
    { type: 'attack', targetId: 'b1', lastKnownPosition: { x: 500, y: 500 } },
    'replace'
  );
  applyPlayerCommand(
    commands,
    { type: 'attack', targetId: 'b1', lastKnownPosition: { x: 510, y: 500 } },
    'append'
  );
  applyPlayerCommand(commands, { type: 'move', x: 600, y: 600 }, 'append');
  applyPlayerCommand(
    commands,
    { type: 'attack', targetId: 'b1', lastKnownPosition: { x: 520, y: 500 } },
    'append'
  );

  assert.equal(removeAttackCommandsTargeting(commands, 'b1'), 3);
  assert.deepEqual(commands.active, { type: 'move', x: 600, y: 600 });
  assert.deepEqual(commands.queue, []);
}

function visibleCampingDeathCompletesOrders() {
  const state = isolatedState(71);
  const blueFlag = MAP.flags.find((flag) => flag.team === 'blue');
  assert.ok(blueFlag);

  state.units.b1.pos = { x: blueFlag!.x, y: blueFlag!.y };
  state.units.r1.pos = findOpenNear(state.units.b1.pos, 120);
  assert.equal(isUnitVisibleToTeam(state, 'red', state.units.b1), true);

  const attack = validatePlayerCommand(state, 'r1', { type: 'attack', targetId: 'b1' });
  assert.ok(attack?.type === 'attack');
  applyPlayerCommand(state.commands.r1, attack!, 'replace');
  applyPlayerCommand(state.commands.r1, attack!, 'append');
  const followup = findOpenNear(state.units.r1.pos, 100);
  applyPlayerCommand(state.commands.r1, { type: 'move', ...followup }, 'append');

  state.units.r1.lastShotAtTick = state.tick;
  state.units.b1.campStartedTick = 0;
  state.tick = msToTicks(GAME_CONFIG.campGraceMs + GAME_CONFIG.campWarningMs);
  step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });

  assert.equal(state.units.b1.alive, false);
  assert.equal(state.units.r1.lock, null);
  assert.deepEqual(state.commands.r1.active, { type: 'move', ...followup });
  assert.deepEqual(state.commands.r1.queue, []);
}

function hiddenCampingDeathPreservesLastKnownOrder() {
  const state = isolatedState(72);
  const visiblePoint = findOpenNear(state.units.r1.pos, 150);
  state.units.b1.pos = visiblePoint;
  assert.equal(isUnitVisibleToTeam(state, 'red', state.units.b1), true);

  const attack = validatePlayerCommand(state, 'r1', { type: 'attack', targetId: 'b1' });
  assert.ok(attack?.type === 'attack');
  applyPlayerCommand(state.commands.r1, attack!, 'replace');

  const blueFlag = MAP.flags.find((flag) => flag.team === 'blue');
  assert.ok(blueFlag);
  state.units.b1.pos = { x: blueFlag!.x, y: blueFlag!.y };
  assert.equal(isUnitVisibleToTeam(state, 'red', state.units.b1), false);
  state.units.b1.campStartedTick = 0;
  state.tick = msToTicks(GAME_CONFIG.campGraceMs + GAME_CONFIG.campWarningMs);

  step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });

  assert.equal(state.units.b1.alive, false);
  const active = state.commands.r1.active;
  assert.ok(active?.type === 'attack');
  assert.deepEqual(active!.lastKnownPosition, visiblePoint);
}

function matchEndClearsCommandsAndLocks() {
  const state = isolatedState(73);
  const target = findOpenNear(state.units.r1.pos, 150);
  state.units.b1.pos = target;
  const attack = validatePlayerCommand(state, 'r1', { type: 'attack', targetId: 'b1' });
  assert.ok(attack?.type === 'attack');
  applyPlayerCommand(state.commands.r1, attack!, 'replace');
  state.units.r1.lock = {
    targetId: 'b1',
    createdAtTick: state.tick,
    lastKnownPosition: { ...target },
  };
  state.tick = msToTicks(GAME_CONFIG.roundDurationMs) - 1;

  step(state, { r1: IDLE_INTENT, b1: IDLE_INTENT });

  assert.equal(state.match.phase, 'ended');
  for (const unit of Object.values(state.units)) {
    assert.deepEqual(state.commands[unit.id], createUnitCommandState());
    assert.equal(unit.lock, null);
  }
}

function snapshotTicksNeverRollBackward() {
  assert.equal(shouldAcceptSnapshotTick(null, 10), true);
  assert.equal(shouldAcceptSnapshotTick(10, 10), false);
  assert.equal(shouldAcceptSnapshotTick(10, 11), true);
  assert.equal(shouldAcceptSnapshotTick(10, 9), false);
  assert.equal(shouldAcceptSnapshotTick(10, Number.NaN), false);
}

function parsed(value: unknown) {
  const result = sanitizePlayerCommandMessage(value);
  assert.ok(result);
  return result!;
}

function isolatedState(seed: number) {
  const state = createGameState(seed);
  for (const id of ['r2', 'b2']) {
    state.units[id].alive = false;
    state.units[id].respawnAtTick = null;
  }
  return state;
}

function findOpenNear(origin: { x: number; y: number }, preferredDistance: number) {
  for (let ring = 0; ring < 30; ring += 1) {
    const distance = Math.max(24, preferredDistance - ring * 4);
    for (let angleIndex = 0; angleIndex < 16; angleIndex += 1) {
      const angle = (angleIndex / 16) * Math.PI * 2;
      const point = {
        x: origin.x + Math.cos(angle) * distance,
        y: origin.y + Math.sin(angle) * distance,
      };
      if (isOpen(point.x, point.y)) return point;
    }
  }
  throw new Error('Could not find nearby open point');
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
