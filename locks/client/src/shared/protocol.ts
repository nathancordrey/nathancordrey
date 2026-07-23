// Network protocol: message shapes shared by server and client. The Snapshot
// is exactly what perceive() allows a team to know, plus match timing —
// nothing more ever crosses the wire.

import type { Team } from './config';
import type { PlayerCommand, VisibleUnitCommandState } from './commands';
import type { MatchState } from './sim';
import type { PerceivedEnemy, Unit } from './state';

export type Snapshot = {
  tick: number;
  remainingMs: number;
  match: MatchState;
  scores: Record<Team, number>;
  flagsAtBase: Record<Team, boolean>;
  carrierIds: Record<Team, string | null>;
  self: Unit;
  allies: Unit[];
  visibleEnemies: PerceivedEnemy[];
  commands: VisibleUnitCommandState;
};

export type WelcomeMessage = {
  unitId: string;
  team: Team;
  tickMs: number;
};

export type RosterInfoEntry = {
  unitId: string;
  name: string;
  human: boolean;
};

// Client → server message types: 'ready' (no payload) once handlers are
// registered; legacy 'intent' while WASD remains enabled; and 'command' with
// PlayerCommandMessage for the authoritative waypoint/attack queue.

export type PlayerCommandMessage = {
  command: PlayerCommand;
  queue: boolean;
  // Optional for backward compatibility. New clients attach a monotonic ID so
  // the owning client can reconcile accepted/rejected commands precisely.
  requestId?: number;
};

export type CommandResultReason =
  | 'invalid-command'
  | 'dead'
  | 'match-ended'
  | 'invalid-destination'
  | 'target-unavailable'
  | 'queue-full'
  | 'input-buffer-full'
  | 'superseded';

export type CommandResultMessage = {
  requestId: number;
  outcome: 'accepted' | 'rejected' | 'superseded';
  reason?: CommandResultReason;
  activeType: 'move' | 'attack' | null;
  queuedCount: number;
};
