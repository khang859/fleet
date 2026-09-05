import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsStore, migrateLegacyScrollback } from '../settings-store';
import { DEFAULT_SCROLLBACK } from '../../shared/types';
// Mock electron-store, seeding `defaults` like the real lib does.
//
// `reads` and `fireChange` are what let the caching in SettingsStore be tested
// at all: one counts the file accesses the real library would have made, the
// other stands in for the watcher noticing somebody else wrote the file.
vi.mock('electron-store', () => {
  const listeners: Array<() => void> = [];
  const counter = { reads: 0 };
  return {
    default: class MockStore {
      private data: Record<string, unknown>;
      constructor(opts?: { defaults?: Record<string, unknown> }) {
        this.data = { ...(opts?.defaults ?? {}) };
      }
      get(key: string, defaultVal?: unknown): unknown {
        counter.reads++;
        return this.data[key] ?? defaultVal;
      }
      set(key: string, value: unknown): void {
        this.data[key] = value;
        for (const listener of listeners) listener();
      }
      onDidAnyChange(callback: () => void): () => void {
        listeners.push(callback);
        return () => listeners.splice(listeners.indexOf(callback), 1);
      }
    },
    __counter: counter,
    __fireChange: (): void => {
      for (const listener of listeners) listener();
    }
  };
});

/** The test-only handles the mock above hangs off the module. */
async function harness(): Promise<{ __counter: { reads: number }; __fireChange: () => void }> {
  return (await vi.importMock('electron-store')) as {
    __counter: { reads: number };
    __fireChange: () => void;
  };
}

describe('SettingsStore settings merge', () => {
  let store: SettingsStore;
  beforeEach(() => {
    store = new SettingsStore();
  });

  it('returns appearance defaults for a fresh store', () => {
    const s = store.get();
    expect(s.general.terminalTheme).toBe('fleet-dark');
    expect(s.general.accentColor).toBe('blue');
  });

  it('merges partial general changes without stale full-object overwrites', () => {
    store.set({ general: { terminalTheme: 'dracula', accentColor: 'teal' } });
    store.set({ general: { fontSize: 16 } });
    const s = store.get();
    expect(s.general.fontSize).toBe(16);
    expect(s.general.terminalTheme).toBe('dracula');
    expect(s.general.accentColor).toBe('teal');
  });

  it('merges a partial terminalBackground change without dropping slideshow settings', () => {
    store.set({
      general: { terminalBackground: { slideshow: { enabled: true, folderPath: '/pics' } } }
    });
    store.set({ general: { terminalBackground: { opacity: 0.5 } } });
    const s = store.get();
    expect(s.general.terminalBackground.opacity).toBe(0.5);
    expect(s.general.terminalBackground.slideshow.enabled).toBe(true);
    expect(s.general.terminalBackground.slideshow.folderPath).toBe('/pics');
    expect(s.general.terminalBackground.slideshow.intervalSeconds).toBe(60); // default preserved
  });

  it('backfills agent.mcpServers for settings saved before it existed', () => {
    // The field is a flat record with whole-replace semantics, so it rides the
    // generic `...current.ai.agent` spread rather than needing a merge line of
    // its own. What must hold is that an agent object saved without the key
    // reads back as `{}` and not as undefined, which would throw on iteration.
    store.set({
      ai: { agent: { systemPrompt: 'be brief' } } as never
    });
    expect(store.get().ai.agent.mcpServers).toEqual({});
    expect(store.get().ai.agent.systemPrompt).toBe('be brief');
  });

  it('replaces the whole mcpServers map rather than merging entries', () => {
    // Removing a server means writing the map without it. An entry-wise merge
    // would make deletion impossible.
    store.set({ ai: { agent: { mcpServers: { a: { enabled: true, url: 'http://a' } } } } });
    store.set({ ai: { agent: { mcpServers: { b: { enabled: true, url: 'http://b' } } } } });
    expect(Object.keys(store.get().ai.agent.mcpServers)).toEqual(['b']);
  });

  it('leaves mcpServers alone when an unrelated agent field is patched', () => {
    store.set({ ai: { agent: { mcpServers: { a: { enabled: true, url: 'http://a' } } } } });
    store.set({ ai: { agent: { compactThreshold: 0.5 } } });
    expect(Object.keys(store.get().ai.agent.mcpServers)).toEqual(['a']);
  });

  it('drops tools and ai capabilities that no longer exist', () => {
    // Settings written by an older version still carry flags for tools that
    // have since been removed. They should not survive the next write.
    store.set({
      tools: { annotate: true, kanban: true, images: false, chat: true },
      ai: { chat: { defaultModel: 'someone/old-model' }, agent: { compactThreshold: 0.5 } }
    } as never);
    expect(store.get().tools).toEqual({ annotate: true, sessions: false, scratch: true });
    expect(Object.keys(store.get().ai)).toEqual(['agent']);
    expect(store.get().ai.agent.compactThreshold).toBe(0.5);
  });
});

/**
 * The agent's permission gate reads the rules before every command it runs, and
 * the real library reads and validates the file on each of those.
 */
describe('SettingsStore caching', () => {
  it('reads the file once however many times it is asked', async () => {
    const { __counter } = await harness();
    const store = new SettingsStore();
    store.get();
    const after = __counter.reads;

    store.get();
    store.get();
    store.get();

    expect(__counter.reads).toBe(after);
  });

  it('re-reads after a write of its own', async () => {
    const { __counter } = await harness();
    const store = new SettingsStore();
    store.get();
    const before = __counter.reads;

    store.set({ general: { fontSize: 15 } });

    expect(store.get().general.fontSize).toBe(15);
    expect(__counter.reads).toBeGreaterThan(before);
  });

  // The reason the cache is allowed to exist: it is invalidated by anything
  // that touches the file, not only by writes made through this object.
  it('re-reads after someone else writes the file', async () => {
    const { __counter, __fireChange } = await harness();
    const store = new SettingsStore();
    store.get();
    const before = __counter.reads;

    store.get();
    expect(__counter.reads).toBe(before);

    __fireChange();
    store.get();

    expect(__counter.reads).toBeGreaterThan(before);
  });
});

// The one transform in this file that rewrites data a user already has on
// disk, and it runs exactly once with no way to undo it - so the cases that
// must not fire are as worth pinning down as the case that must.
describe('legacy scrollback migration', () => {
  it('rewrites the old default nobody ever actually received', () => {
    const migrated = migrateLegacyScrollback({ general: { scrollbackSize: 10_000 } });
    expect(migrated.general?.scrollbackSize).toBe(DEFAULT_SCROLLBACK);
  });

  it('leaves a value the user chose alone', () => {
    const saved = { general: { scrollbackSize: 5000 } };
    expect(migrateLegacyScrollback(saved)).toBe(saved);
  });

  it('carries the rest of the settings through untouched', () => {
    const migrated = migrateLegacyScrollback({
      general: { scrollbackSize: 10_000, fontSize: 16, terminalTheme: 'dracula' },
      annotate: { retentionDays: 7 }
    });
    expect(migrated.general?.fontSize).toBe(16);
    expect(migrated.general?.terminalTheme).toBe('dracula');
    expect(migrated.annotate?.retentionDays).toBe(7);
  });

  it('survives a settings file saved before `general` existed', () => {
    const saved = {};
    expect(migrateLegacyScrollback(saved)).toBe(saved);
  });
});
