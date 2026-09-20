import { describe, it, expect } from 'vitest';
import { nextPendingTabId } from '../use-deferred-tab-mount';

describe('nextPendingTabId', () => {
  it('skips the active tab, which mounts without waiting its turn', () => {
    expect(nextPendingTabId(['a', 'b', 'c'], 'a', new Set())).toBe('b');
  });

  it('releases in list order so the active workspace goes before background ones', () => {
    expect(nextPendingTabId(['a', 'b', 'c'], 'a', new Set(['b']))).toBe('c');
  });

  it('returns undefined once every tab is released', () => {
    expect(nextPendingTabId(['a', 'b'], 'a', new Set(['b']))).toBeUndefined();
  });

  it('queues tabs that appear later, such as background workspaces loaded after boot', () => {
    expect(nextPendingTabId(['a', 'b', 'bg1'], 'a', new Set(['b']))).toBe('bg1');
  });

  it('has nothing pending before a tab is active', () => {
    expect(nextPendingTabId([], null, new Set())).toBeUndefined();
  });
});
