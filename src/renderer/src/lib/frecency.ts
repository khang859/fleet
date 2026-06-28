export type FrecencyEntry = { score: number; lastUsed: number };
export type FrecencyMap = Record<string, FrecencyEntry>;

const HALF_LIFE_MS = 10 * 86_400_000; // 10 days
const DECAY = Math.LN2 / HALF_LIFE_MS;

export function decayedScore(entry: FrecencyEntry, now: number): number {
  const dt = Math.max(0, now - entry.lastUsed);
  return entry.score * Math.exp(-DECAY * dt);
}

export function recordUse(map: FrecencyMap, id: string, now: number): FrecencyMap {
  const base = id in map ? decayedScore(map[id], now) : 0;
  return { ...map, [id]: { score: base + 1, lastUsed: now } };
}

export function rankIds(map: FrecencyMap, now: number): string[] {
  return Object.keys(map).sort((a, b) => decayedScore(map[b], now) - decayedScore(map[a], now));
}
