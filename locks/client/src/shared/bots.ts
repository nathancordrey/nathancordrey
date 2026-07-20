// Bot brains: pure functions from perceived state to intent. Bots see only
// what their team sees (the perception filter enforces this), and their
// intents run through the exact same step() rules as human players.

import type { Intent, PerceivedState } from './state';
import { IDLE_INTENT } from './state';

export type BotBrain = (view: PerceivedState) => Intent;

// Phase 1: stand still. Phase 2 replaces this with
// patrol -> react (delayed) -> lock -> sweep last-known.
export const idleBrain: BotBrain = () => IDLE_INTENT;
