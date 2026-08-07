import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsStore } from '../settings-store';
// Mock electron-store, seeding `defaults` like the real lib does.
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Record<string, unknown>;
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      this.data = { ...(opts?.defaults ?? {}) };
    }
    get(key: string, defaultVal?: unknown): unknown {
      return this.data[key] ?? defaultVal;
    }
    set(key: string, value: unknown): void {
      this.data[key] = value;
    }
  }
}));

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
    expect(store.get().tools).toEqual({ annotate: true, sessions: false });
    expect(Object.keys(store.get().ai)).toEqual(['agent']);
    expect(store.get().ai.agent.compactThreshold).toBe(0.5);
  });
});
