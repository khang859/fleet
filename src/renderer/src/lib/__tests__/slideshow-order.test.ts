import { describe, it, expect } from 'vitest';
import { buildQueue } from '../slideshow-order';

const PATHS = ['/a.png', '/b.png', '/c.png', '/d.png'];

describe('buildQueue', () => {
  it('returns [] for an empty list', () => {
    expect(buildQueue([], false, null)).toEqual([]);
    expect(buildQueue([], true, '/a.png')).toEqual([]);
  });

  it('sequential: preserves order from the start when nothing was shown', () => {
    expect(buildQueue(PATHS, false, null)).toEqual(PATHS);
  });

  it('sequential: rotates to continue after the last shown image', () => {
    expect(buildQueue(PATHS, false, '/b.png')).toEqual(['/c.png', '/d.png', '/a.png', '/b.png']);
  });

  it('sequential: starts over when lastShown is no longer in the list', () => {
    expect(buildQueue(PATHS, false, '/gone.png')).toEqual(PATHS);
  });

  it('shuffle: returns a permutation of all paths', () => {
    const queue = buildQueue(PATHS, true, null);
    expect([...queue].sort()).toEqual([...PATHS].sort());
  });

  it('shuffle: never starts with the last shown image (100 rolls)', () => {
    for (let i = 0; i < 100; i++) {
      expect(buildQueue(PATHS, true, '/c.png')[0]).not.toBe('/c.png');
    }
  });

  it('shuffle: single image still returns that image', () => {
    expect(buildQueue(['/only.png'], true, '/only.png')).toEqual(['/only.png']);
  });

  it('does not mutate the input array', () => {
    const input = [...PATHS];
    buildQueue(input, true, null);
    expect(input).toEqual(PATHS);
  });
});
