import { describe, it, expect } from 'vitest';
import { shouldCheck, MIN_CHECK_GAP_MS, UPDATE_CHECK_INTERVAL_MS } from '../update-scheduler';

const NOW = 1_800_000_000_000;

describe('shouldCheck', () => {
  it('runs the first check, having nothing to compare against', () => {
    expect(shouldCheck(NOW, null)).toBe(true);
  });

  it('refuses a second check inside the gap', () => {
    expect(shouldCheck(NOW, NOW - 60_000)).toBe(false);
  });

  it('refuses one arriving a moment early', () => {
    expect(shouldCheck(NOW, NOW - MIN_CHECK_GAP_MS + 1)).toBe(false);
  });

  it('allows one exactly on the boundary', () => {
    expect(shouldCheck(NOW, NOW - MIN_CHECK_GAP_MS)).toBe(true);
  });

  it('allows one well past the gap', () => {
    expect(shouldCheck(NOW, NOW - UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });

  /**
   * A lid opening fires the wake and the focus together, and the timer may be
   * due in the same breath. Three triggers, one check - the whole point of
   * routing them through here.
   */
  it('collapses a burst of triggers into one check', () => {
    let lastCheckAt: number | null = null;
    let checks = 0;
    for (const at of [NOW, NOW + 5, NOW + 12]) {
      if (shouldCheck(at, lastCheckAt)) {
        checks += 1;
        lastCheckAt = at;
      }
    }
    expect(checks).toBe(1);
  });

  /** The clock going backwards must not unlock an unbounded run of checks. */
  it('holds when the clock jumps backwards', () => {
    expect(shouldCheck(NOW, NOW + 60_000)).toBe(false);
  });
});
