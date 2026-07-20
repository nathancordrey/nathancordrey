// Capture-the-flag rules. Pure — shared by client and server.

import type { Vec2 } from './geometry';
import { distance } from './geometry';
import type { FlagDef, Team } from './config';

// --- Capture the flag -----------------------------------------------------
// Rules (per the original SC maps): the carrier is NOT revealed and shoots
// normally. Death returns the flag straight home — no dropped-flag state.
// Score by carrying the enemy flag into your own flag zone.

export type CtfFlagState = { atBase: boolean; carrierId: string | null };

export type CtfState = {
  flags: Record<Team, CtfFlagState>;
  scores: Record<Team, number>;
};

export function createCtfState(): CtfState {
  return {
    flags: {
      red: { atBase: true, carrierId: null },
      blue: { atBase: true, carrierId: null },
    },
    scores: { red: 0, blue: 0 },
  };
}

export function carriedFlagTeam(state: CtfState, playerId: string): Team | null {
  for (const team of Object.keys(state.flags) as Team[]) {
    if (state.flags[team].carrierId === playerId) return team;
  }
  return null;
}

// Touch the enemy flag while it's home to pick it up.
export function tryGrabFlag(
  state: CtfState,
  playerId: string,
  playerTeam: Team,
  playerPos: Vec2,
  flags: FlagDef[],
  grabRadius: number
): boolean {
  if (carriedFlagTeam(state, playerId) !== null) return false;

  for (const flag of flags) {
    if (flag.team === playerTeam) continue;
    const flagState = state.flags[flag.team];
    if (!flagState.atBase || flagState.carrierId !== null) continue;
    if (distance(playerPos, { x: flag.x, y: flag.y }) <= grabRadius) {
      flagState.atBase = false;
      flagState.carrierId = playerId;
      return true;
    }
  }
  return false;
}

// Carry the enemy flag into your own flag zone to score; flag returns home.
export function tryCaptureFlag(
  state: CtfState,
  playerId: string,
  playerTeam: Team,
  playerPos: Vec2,
  flags: FlagDef[],
  captureRadius: number
): boolean {
  const carried = carriedFlagTeam(state, playerId);
  if (carried === null || carried === playerTeam) return false;

  const ownFlag = flags.find((flag) => flag.team === playerTeam);
  if (!ownFlag) return false;

  if (distance(playerPos, { x: ownFlag.x, y: ownFlag.y }) <= captureRadius) {
    state.flags[carried] = { atBase: true, carrierId: null };
    state.scores[playerTeam] += 1;
    return true;
  }
  return false;
}

// Death sends any carried flag straight home.
export function returnFlagOnDeath(state: CtfState, playerId: string): boolean {
  const carried = carriedFlagTeam(state, playerId);
  if (carried === null) return false;
  state.flags[carried] = { atBase: true, carrierId: null };
  return true;
}

