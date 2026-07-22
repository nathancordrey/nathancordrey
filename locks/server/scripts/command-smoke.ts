// Command-model smoke test. Exercises deterministic queue semantics, server
// validation, and lifecycle clearing used by waypoint execution.

import assert from 'node:assert/strict';

import {
  MAX_COMMAND_QUEUE,
  applyPlayerCommand,
  clearUnitCommands,
  completeActiveCommand,
  createUnitCommandState,
} from '../../client/src/shared/commands.js';
import { GAME_CONFIG, MAP } from '../../client/src/shared/config.js';
import { createGameState, IDLE_INTENT, msToTicks, step } from '../../client/src/shared/state.js';
import { sanitizePlayerCommandMessage, validatePlayerCommand } from '../src/playerCommands.js';

function main() {
  const state = createGameState(17);
  const redCommands = state.commands.r1;

  assert.deepEqual(redCommands, createUnitCommandState());

  assert.equal(
    applyPlayerCommand(redCommands, { type: 'move', x: 500, y: 500 }, 'replace'),
    'applied'
  );
  assert.deepEqual(redCommands.active, { type: 'move', x: 500, y: 500 });

  assert.equal(
    applyPlayerCommand(redCommands, { type: 'attack', targetId: 'b1' }, 'append'),
    'applied'
  );
  assert.deepEqual(redCommands.queue, [{ type: 'attack', targetId: 'b1' }]);

  completeActiveCommand(redCommands);
  assert.deepEqual(redCommands.active, { type: 'attack', targetId: 'b1' });
  assert.deepEqual(redCommands.queue, []);

  for (let index = 0; index < MAX_COMMAND_QUEUE; index += 1) {
    assert.equal(
      applyPlayerCommand(
        redCommands,
        { type: 'move', x: 600 + index, y: 600 },
        'append'
      ),
      'applied'
    );
  }
  assert.equal(redCommands.queue.length, MAX_COMMAND_QUEUE);
  assert.equal(
    applyPlayerCommand(redCommands, { type: 'move', x: 999, y: 999 }, 'append'),
    'queue-full'
  );

  assert.equal(applyPlayerCommand(redCommands, { type: 'stop' }, 'append'), 'cleared');
  assert.deepEqual(redCommands, createUnitCommandState());

  assert.deepEqual(
    sanitizePlayerCommandMessage({
      command: { type: 'move', x: 800, y: 900 },
      queue: true,
    }),
    { command: { type: 'move', x: 800, y: 900 }, queue: true }
  );
  assert.equal(
    sanitizePlayerCommandMessage({ command: { type: 'move', x: Number.NaN, y: 3 } }),
    null
  );

  const validPoint = findOpenPoint();
  assert.deepEqual(
    validatePlayerCommand(state, 'r1', { type: 'move', ...validPoint }),
    { type: 'move', ...validPoint }
  );
  assert.equal(
    validatePlayerCommand(state, 'r1', { type: 'move', x: -1, y: 200 }),
    null
  );
  assert.equal(
    validatePlayerCommand(state, 'r1', { type: 'move', x: 12, y: 12 }),
    null
  );

  // Enemy is initially outside red vision, so acquisition must be rejected.
  assert.equal(
    validatePlayerCommand(state, 'r1', { type: 'attack', targetId: 'b1' }),
    null
  );
  state.units.b1.pos = { x: state.units.r1.pos.x + 50, y: state.units.r1.pos.y };
  assert.deepEqual(
    validatePlayerCommand(state, 'r1', { type: 'attack', targetId: 'b1' }),
    { type: 'attack', targetId: 'b1' }
  );

  state.units.r1.alive = false;
  assert.equal(validatePlayerCommand(state, 'r1', { type: 'stop' }), null);

  // Respawn clears stale commands.
  const respawnState = createGameState(18);
  applyPlayerCommand(
    respawnState.commands.r1,
    { type: 'move', x: validPoint.x, y: validPoint.y },
    'replace'
  );
  respawnState.units.r1.alive = false;
  respawnState.units.r1.respawnAtTick = 1;
  step(respawnState, {});
  assert.equal(respawnState.units.r1.alive, true);
  assert.deepEqual(respawnState.commands.r1, createUnitCommandState());

  // Camping death also clears active and queued commands.
  const deathState = createGameState(19);
  const redFlag = MAP.flags.find((flag) => flag.team === 'red');
  assert.ok(redFlag);
  deathState.units.r1.pos = { x: redFlag.x, y: redFlag.y };
  deathState.units.r1.campStartedTick = 0;
  deathState.tick = msToTicks(GAME_CONFIG.campGraceMs + GAME_CONFIG.campWarningMs);
  applyPlayerCommand(
    deathState.commands.r1,
    { type: 'move', x: validPoint.x, y: validPoint.y },
    'replace'
  );
  step(deathState, { r1: IDLE_INTENT });
  assert.equal(deathState.units.r1.alive, false);
  assert.deepEqual(deathState.commands.r1, createUnitCommandState());

  // The same ordered stream produces the same command state.
  const first = createGameState(20);
  const second = createGameState(20);
  const stream = [
    { command: { type: 'move', x: 700, y: 700 } as const, mode: 'replace' as const },
    { command: { type: 'move', x: 800, y: 700 } as const, mode: 'append' as const },
    { command: { type: 'attack', targetId: 'b1' } as const, mode: 'append' as const },
  ];
  for (const entry of stream) {
    applyPlayerCommand(first.commands.r1, entry.command, entry.mode);
    applyPlayerCommand(second.commands.r1, entry.command, entry.mode);
  }
  assert.deepEqual(first.commands, second.commands);

  clearUnitCommands(first.commands.r1);
  assert.deepEqual(first.commands.r1, createUnitCommandState());

  console.log('COMMAND SMOKE PASS');
}

function findOpenPoint() {
  for (let y = 100; y < GAME_CONFIG.worldHeight - 100; y += 36) {
    for (let x = 100; x < GAME_CONFIG.worldWidth - 100; x += 36) {
      if (
        validatePlayerCommand(createGameState(), 'r1', { type: 'move', x, y }) !== null
      ) {
        return { x, y };
      }
    }
  }
  throw new Error('No open point found');
}

main();
