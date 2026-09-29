import { describe, it, expect, vi } from 'vitest';

/** Like electron-store: `defaults` are applied once, on construction, into the file's data. */
const files = new Map<string, Record<string, unknown>>();
vi.mock('electron-store', () => ({
  default: class {
    private readonly name: string;
    constructor(opts: { name: string; defaults?: Record<string, unknown> }) {
      this.name = opts.name;
      files.set(opts.name, { ...opts.defaults, ...files.get(opts.name) });
    }
    get(key: string, fallback?: unknown): unknown {
      return files.get(this.name)?.[key] ?? fallback;
    }
    set(patch: Record<string, unknown>): void {
      files.set(this.name, { ...files.get(this.name), ...patch });
    }
  }
}));

import { BoundsStore } from '../bounds-store';

describe('BoundsStore', () => {
  it('remembers a rect per display', () => {
    const store = new BoundsStore();
    const rect = { x: 1, y: 2, width: 300, height: 100 };
    store.save(4, rect);
    store.save(5, { ...rect, x: 9 });
    expect(store.load()).toEqual({
      lastDisplayId: 5,
      byDisplay: { '4': rect, '5': { ...rect, x: 9 } }
    });
  });

  it('reads as empty, not broken, when the file is deleted while Fleet runs', () => {
    const store = new BoundsStore();
    store.save(4, { x: 1, y: 2, width: 300, height: 100 });
    files.clear();
    expect(store.load()).toEqual({ lastDisplayId: null, byDisplay: {} });
    store.save(6, { x: 0, y: 0, width: 300, height: 100 });
    expect(Object.keys(store.load().byDisplay)).toEqual(['6']);
  });
});
