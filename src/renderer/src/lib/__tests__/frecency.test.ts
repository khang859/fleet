import { describe, it, expect } from 'vitest';
import { recordUse, decayedScore, rankIds } from '../frecency';

const DAY = 86_400_000;

describe('frecency', () => {
  it('adds 1 on first use', () => {
    const map = recordUse({}, 'a', 0);
    expect(map.a.score).toBe(1);
    expect(map.a.lastUsed).toBe(0);
  });

  it('decays the prior score before adding on repeat use', () => {
    const first = recordUse({}, 'a', 0);
    // one 10-day half-life later, prior score halves then +1
    const second = recordUse(first, 'a', 10 * DAY);
    expect(second.a.score).toBeCloseTo(1.5, 5);
    expect(second.a.lastUsed).toBe(10 * DAY);
  });

  it('decayedScore halves over one half-life', () => {
    const entry = { score: 2, lastUsed: 0 };
    expect(decayedScore(entry, 10 * DAY)).toBeCloseTo(1, 5);
  });

  it('ranks ids by decayed score descending', () => {
    let map = {};
    map = recordUse(map, 'old', 0);
    map = recordUse(map, 'recent', 9 * DAY);
    expect(rankIds(map, 9 * DAY)).toEqual(['recent', 'old']);
  });

  it('does not mutate the input map', () => {
    const map = { a: { score: 1, lastUsed: 0 } };
    recordUse(map, 'a', DAY);
    expect(map.a.score).toBe(1);
  });
});
