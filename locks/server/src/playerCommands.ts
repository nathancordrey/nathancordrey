// Server-side parsing and validation for the shared player-command model.
// The browser submits desired commands; only validated commands enter the
// deterministic simulation queue.

import { GAME_CONFIG, MAP } from '../../client/src/shared/config.js';
import { collidesWithWalls } from '../../client/src/shared/movement.js';
import type { PlayerCommand } from '../../client/src/shared/commands.js';
import type { PlayerCommandMessage } from '../../client/src/shared/protocol.js';
import { isUnitVisibleToTeam } from '../../client/src/shared/state.js';
import type { GameState } from '../../client/src/shared/state.js';

export type SanitizedPlayerCommandMessage = PlayerCommandMessage;

export function sanitizePlayerCommandMessage(
  data: unknown
): SanitizedPlayerCommandMessage | null {
  if (!isRecord(data) || !isRecord(data.command)) return null;

  const raw = data.command;
  const queue = data.queue === true;

  if (raw.type === 'stop') {
    return { command: { type: 'stop' }, queue: false };
  }

  if (raw.type === 'move') {
    if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
    return {
      command: { type: 'move', x: raw.x, y: raw.y },
      queue,
    };
  }

  if (raw.type === 'attack' && typeof raw.targetId === 'string') {
    const targetId = raw.targetId.trim().slice(0, 32);
    if (targetId.length === 0) return null;
    return {
      command: { type: 'attack', targetId },
      queue,
    };
  }

  return null;
}

export function validatePlayerCommand(
  state: GameState,
  unitId: string,
  command: PlayerCommand
): PlayerCommand | null {
  const source = state.units[unitId];
  if (source === undefined || !source.alive || state.match.phase === 'ended') return null;

  if (command.type === 'stop') return { type: 'stop' };

  if (command.type === 'move') {
    const { x, y } = command;
    const radius = GAME_CONFIG.playerRadius;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < radius ||
      y < radius ||
      x > GAME_CONFIG.worldWidth - radius ||
      y > GAME_CONFIG.worldHeight - radius ||
      collidesWithWalls(x, y, radius, MAP.walls)
    ) {
      return null;
    }
    return { type: 'move', x, y };
  }

  const target = state.units[command.targetId];
  if (
    target === undefined ||
    !target.alive ||
    target.team === source.team ||
    !isUnitVisibleToTeam(state, source.team, target)
  ) {
    return null;
  }

  return { type: 'attack', targetId: target.id };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
