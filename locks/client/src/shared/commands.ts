// Authoritative player-command queue primitives. Pure simulation data and
// deterministic queue operations; input devices and network validation live
// outside this module.

export const MAX_COMMAND_QUEUE = 10;

export type MoveCommand = {
  type: 'move';
  x: number;
  y: number;
};

export type AttackCommand = {
  type: 'attack';
  targetId: string;
};

export type StopCommand = {
  type: 'stop';
};

export type PlayerCommand = MoveCommand | AttackCommand | StopCommand;
export type ExecutablePlayerCommand = MoveCommand | AttackCommand;
export type CommandQueueMode = 'replace' | 'append';

export type UnitCommandState = {
  active: ExecutablePlayerCommand | null;
  queue: ExecutablePlayerCommand[];
};

export type ApplyCommandResult = 'applied' | 'cleared' | 'queue-full';

export function createUnitCommandState(): UnitCommandState {
  return { active: null, queue: [] };
}

export function applyPlayerCommand(
  state: UnitCommandState,
  command: PlayerCommand,
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
    return 'applied';
  }

  if (state.active === null) {
    state.active = safeCommand;
    return 'applied';
  }

  if (state.queue.length >= MAX_COMMAND_QUEUE) return 'queue-full';
  state.queue.push(safeCommand);
  return 'applied';
}

export function completeActiveCommand(state: UnitCommandState): void {
  state.active = state.queue.shift() ?? null;
}

export function clearUnitCommands(state: UnitCommandState): void {
  state.active = null;
  state.queue = [];
}

function cloneExecutableCommand(command: ExecutablePlayerCommand): ExecutablePlayerCommand {
  return command.type === 'move'
    ? { type: 'move', x: command.x, y: command.y }
    : { type: 'attack', targetId: command.targetId };
}
