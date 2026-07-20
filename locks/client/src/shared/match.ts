// Match timer and win condition. Pure — shared by client and server.

import type { Team } from './config';
import type { CtfState } from './ctf';

// --- Match timer & win condition -----------------------------------------
// First to scoreToWin caps wins. If the clock runs out first, higher score
// wins; equal scores = draw.

export type MatchResult = Team | 'draw';

export type MatchState = {
  phase: 'playing' | 'ended';
  result: MatchResult | null;
};

export function createMatchState(): MatchState {
  return { phase: 'playing', result: null };
}

// Returns true if this call ended the match.
export function evaluateMatch(
  match: MatchState,
  ctf: CtfState,
  remainingMs: number,
  scoreToWin: number
): boolean {
  if (match.phase === 'ended') return false;

  for (const team of Object.keys(ctf.scores) as Team[]) {
    if (ctf.scores[team] >= scoreToWin) {
      match.phase = 'ended';
      match.result = team;
      return true;
    }
  }

  if (remainingMs <= 0) {
    match.phase = 'ended';
    if (ctf.scores.red > ctf.scores.blue) match.result = 'red';
    else if (ctf.scores.blue > ctf.scores.red) match.result = 'blue';
    else match.result = 'draw';
    return true;
  }

  return false;
}

