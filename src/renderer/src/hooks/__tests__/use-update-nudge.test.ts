import { describe, it, expect } from 'vitest';
import { shouldToast, RE_TOAST_GAP_MS, type LastToast } from '../use-update-nudge';

const NOW = 1_800_000_000_000;
const V = '2.113.0';

describe('shouldToast', () => {
  it('announces a version nothing has been said about', () => {
    expect(shouldToast(NOW, V, null)).toBe(true);
  });

  it('stays quiet about the version it just announced', () => {
    expect(shouldToast(NOW, V, { version: V, at: NOW - 60_000 })).toBe(false);
  });

  it('stays quiet a moment short of the gap', () => {
    expect(shouldToast(NOW, V, { version: V, at: NOW - RE_TOAST_GAP_MS + 1 })).toBe(false);
  });

  it('says it again once a day has passed', () => {
    expect(shouldToast(NOW, V, { version: V, at: NOW - RE_TOAST_GAP_MS })).toBe(true);
  });

  /**
   * A release landing on top of one the user already ignored is new
   * information, and it is also the point at which they are two versions back.
   */
  it('announces a newer version immediately, gap or no gap', () => {
    const last: LastToast = { version: '2.113.0', at: NOW - 1000 };
    expect(shouldToast(NOW, '2.114.0', last)).toBe(true);
  });

  /** The pill is the persistent half of the nudge; the toast must not become one. */
  it('says nothing on a burst of status events for the same version', () => {
    let last: LastToast | null = null;
    let said = 0;
    for (const at of [NOW, NOW + 1, NOW + 2, NOW + 3]) {
      if (shouldToast(at, V, last)) {
        said += 1;
        last = { version: V, at };
      }
    }
    expect(said).toBe(1);
  });
});
