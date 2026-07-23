// Server-side parsing, buffering, and validation for the shared player-command
// model. The browser submits desired commands; only validated commands enter
// the deterministic simulation queue.

import { GAME_CONFIG, MAP } from '../../client/src/shared/config.js';
import { collidesWithWalls } from '../../client/src/shared/movement.js';
import type {
  PlayerCommand,
  ValidatedPlayerCommand,
} from '../../client/src/shared/commands.js';
import type { CommandResultReason } from '../../client/src/shared/protocol.js';
import { isUnitVisibleToTeam } from '../../client/src/shared/state.js';
import type { GameState } from '../../client/src/shared/state.js';

export type SanitizedPlayerCommandMessage = {
  command: PlayerCommand;
  queue: boolean;
  requestId: number | null;
};

export type CommandValidationResult =
  | { ok: true; command: ValidatedPlayerCommand }
  | { ok: false; reason: CommandResultReason };

export type BufferPendingResult = {
  buffered: boolean;
  superseded: SanitizedPlayerCommandMessage[];
  reason?: 'input-buffer-full';
};

export const MAX_PENDING_COMMANDS = 32;

export function sanitizePlayerCommandMessage(
  data: unknown
): SanitizedPlayerCommandMessage | null {
  if (!isRecord(data) || !isRecord(data.command)) return null;

  const raw = data.command;
  const queue = data.queue === true;
  const requestId = sanitizeRequestId(data.requestId);

  if (raw.type === 'stop') {
    return { command: { type: 'stop' }, queue: false, requestId };
  }

  if (raw.type === 'move') {
    if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
    return {
      command: { type: 'move', x: raw.x, y: raw.y },
      queue,
      requestId,
    };
  }

  if (raw.type === 'attack' && typeof raw.targetId === 'string') {
    const targetId = raw.targetId.trim().slice(0, 32);
    if (targetId.length === 0) return null;
    // Never accept a browser-provided last-known position. Validation below
    // captures the target's authoritative currently visible position.
    return {
      command: { type: 'attack', targetId },
      queue,
      requestId,
    };
  }

  return null;
}

// Preserve command semantics even when many browser messages arrive between
// simulation ticks. STOP and non-queued replacements always supersede older
// unprocessed input, so they can never be starved behind a full append buffer.
export function bufferPendingPlayerCommand(
  pending: SanitizedPlayerCommandMessage[],
  message: SanitizedPlayerCommandMessage,
  limit: number = MAX_PENDING_COMMANDS
): BufferPendingResult {
  if (message.command.type === 'stop' || message.queue === false) {
    const superseded = pending.splice(0);
    pending.push(message);
    return { buffered: true, superseded };
  }

  if (pending.length >= limit) {
    return { buffered: false, superseded: [], reason: 'input-buffer-full' };
  }

  pending.push(message);
  return { buffered: true, superseded: [] };
}

export function validatePlayerCommandDetailed(
  state: GameState,
  unitId: string,
  command: PlayerCommand
): CommandValidationResult {
  const source = state.units[unitId];
  if (source === undefined) return { ok: false, reason: 'invalid-command' };
  if (state.match.phase === 'ended') return { ok: false, reason: 'match-ended' };
  if (!source.alive) return { ok: false, reason: 'dead' };

  if (command.type === 'stop') return { ok: true, command: { type: 'stop' } };

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
      return { ok: false, reason: 'invalid-destination' };
    }
    return { ok: true, command: { type: 'move', x, y } };
  }

  const target = state.units[command.targetId];
  if (
    target === undefined ||
    !target.alive ||
    target.team === source.team ||
    !isUnitVisibleToTeam(state, source.team, target)
  ) {
    return { ok: false, reason: 'target-unavailable' };
  }

  return {
    ok: true,
    command: {
      type: 'attack',
      targetId: target.id,
      lastKnownPosition: { ...target.pos },
    },
  };
}

// Back-compatible convenience used by existing tests and callers.
export function validatePlayerCommand(
  state: GameState,
  unitId: string,
  command: PlayerCommand
): ValidatedPlayerCommand | null {
  const result = validatePlayerCommandDetailed(state, unitId, command);
  return result.ok ? result.command : null;
}

function sanitizeRequestId(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return null;
  }
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
