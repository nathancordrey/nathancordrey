// Authoritative player-command queue primitives. Pure simulation data and
// deterministic queue operations; input devices and network validation live
// outside this module.

import type { Vec2 } from './geometry';

export const MAX_COMMAND_QUEUE = 10;

export type MoveCommand = {
  type: 'move';
  x: number;
  y: number;
};

// Browser request shape. The authoritative server captures the target's
// currently visible position and turns this into an ExecutableAttackCommand.
export type AttackCommand = {
  type: 'attack';
  targetId: string;
};

export type ExecutableAttackCommand = AttackCommand & {
  // Trusted position from the last tick on which the target was visible to
  // the attacker's team. It is updated by the shared simulation and never by
  // a hidden target's real position.
  lastKnownPosition: Vec2;
};

export type StopCommand = {
  type: 'stop';
};

export type PlayerCommand = MoveCommand | AttackCommand | StopCommand;
export type ExecutablePlayerCommand = MoveCommand | ExecutableAttackCommand;
export type ValidatedPlayerCommand = ExecutablePlayerCommand | StopCommand;
export type CommandQueueMode = 'replace' | 'append';

// Path execution is simulation-only state. It intentionally remains beside
// the active command so a saved/replayed deterministic state contains every
// input needed to continue the same route.
export type UnitCommandState = {
  active: ExecutablePlayerCommand | null;
  queue: ExecutablePlayerCommand[];
  path: Vec2[];
  pathIndex: number;
  pathGoal: Vec2 | null;
};

// Sent only to the owning client. Attack last-known positions are safe here:
// they are positions that player's team already observed, and they let the UI
// draw queued attack orders without exposing hidden real-time coordinates.
export type VisibleUnitCommandState = {
  active: ExecutablePlayerCommand | null;
  queue: ExecutablePlayerCommand[];
};

export type ApplyCommandResult = 'applied' | 'cleared' | 'queue-full';

export function createUnitCommandState(): UnitCommandState {
  return {
    active: null,
    queue: [],
    path: [],
    pathIndex: 0,
    pathGoal: null,
  };
}

export function visibleUnitCommandState(state: UnitCommandState): VisibleUnitCommandState {
  return {
    active: state.active === null ? null : cloneExecutableCommand(state.active),
    queue: state.queue.map(cloneExecutableCommand),
  };
}

export function applyPlayerCommand(
  state: UnitCommandState,
  command: ValidatedPlayerCommand,
  mode: CommandQueueMode
): ApplyCommandResult {
  if (command.type === 'stop') {
    clearUnitCommands(state);
    return 'cleared';
  }

  const safeCommand = cloneExecutableCommand(command);

  if (mode === 'replace') {
    state.active = safeCommand;
    state.queue = [];
    resetActiveCommandRuntime(state);
    return 'applied';
  }

  if (state.active === null) {
    state.active = safeCommand;
    resetActiveCommandRuntime(state);
    return 'applied';
  }

  if (state.queue.length >= MAX_COMMAND_QUEUE) return 'queue-full';
  state.queue.push(safeCommand);
  return 'applied';
}

export function completeActiveCommand(state: UnitCommandState): void {
  state.active = state.queue.shift() ?? null;
  resetActiveCommandRuntime(state);
}

export function clearUnitCommands(state: UnitCommandState): void {
  state.active = null;
  state.queue = [];
  resetActiveCommandRuntime(state);
}

export function resetActiveCommandRuntime(state: UnitCommandState): void {
  state.path = [];
  state.pathIndex = 0;
  state.pathGoal = null;
}

function cloneExecutableCommand(command: ExecutablePlayerCommand): ExecutablePlayerCommand {
  return command.type === 'move'
    ? { type: 'move', x: command.x, y: command.y }
    : {
        type: 'attack',
        targetId: command.targetId,
        lastKnownPosition: { ...command.lastKnownPosition },
      };
}
