// Deterministic PRNG. All simulation randomness (bot reaction jitter, patrol
// and sweep variation) draws from a seed stored in GameState and advanced
// inside step(), never from Math.random() — this preserves the determinism
// rule (same seed + same intents => identical results, for replays/server).

export type RngState = { seed: number };

export function createRng(seed: number): RngState {
  // Force to uint32 so behaviour is identical across machines.
  return { seed: seed >>> 0 };
}

// mulberry32: tiny, fast, good enough for gameplay jitter. Mutates state.
export function nextRandom(rng: RngState): number {
  rng.seed = (rng.seed + 0x6d2b79f5) >>> 0;
  let t = rng.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randomRange(rng: RngState, min: number, max: number): number {
  return min + (max - min) * nextRandom(rng);
}

export function randomInt(rng: RngState, minInclusive: number, maxInclusive: number): number {
  return Math.floor(randomRange(rng, minInclusive, maxInclusive + 1));
}
