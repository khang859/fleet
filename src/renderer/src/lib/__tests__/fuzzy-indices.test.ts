import { describe, expect, it } from 'vitest';
import { fuzzyIndices, fuzzyMatch } from '../commands';

describe('fuzzyIndices', () => {
  it('finds each query letter in order, ignoring case', () => {
    expect(fuzzyIndices('FLT', 'fleet')).toEqual([0, 1, 4]);
  });

  it('is null when the letters are not all there in order', () => {
    expect(fuzzyIndices('tf', 'fleet')).toBeNull();
    expect(fuzzyMatch('tf', 'fleet')).toBe(false);
  });

  it('matches everything with an empty query and marks nothing', () => {
    expect(fuzzyIndices('', 'fleet')).toEqual([]);
    expect(fuzzyMatch('', 'fleet')).toBe(true);
  });
});
