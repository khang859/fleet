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

  it('returns kanban defaults for a fresh store', () => {
    const s = store.get();
    expect(s.kanban.dispatcher.intervalMs).toBe(5000);
    expect(s.kanban.dispatcher.maxInProgress).toBe(3);
    expect(s.kanban.profiles.map((p) => p.name)).toContain('default');
    expect(s.kanban.profiles.map((p) => p.name)).toContain('orchestrator');
  });

  it('merges a partial dispatcher change without dropping siblings or profiles', () => {
    store.set({
      kanban: { dispatcher: { intervalMs: 3000 } }
    });
    const s = store.get();
    expect(s.kanban.dispatcher.intervalMs).toBe(3000);
    expect(s.kanban.dispatcher.maxInProgress).toBe(3); // sibling preserved
    expect(s.kanban.profiles.length).toBeGreaterThan(0); // profiles preserved
  });

  it('replaces the profiles array wholesale when provided', () => {
    store.set({
      kanban: { profiles: [{ name: 'solo', model: '', skills: [], instructions: 'x' } as never] }
    });
    expect(store.get().kanban.profiles.map((p) => p.name)).toEqual(['solo']);
  });

  it('merges a partial defaults change without dropping maxRuntimeSeconds', () => {
    store.set({
      kanban: { defaults: { workspaceKind: 'dir' } }
    });
    const s = store.get();
    expect(s.kanban.defaults.workspaceKind).toBe('dir');
    expect(s.kanban.defaults.maxRuntimeSeconds).toBeNull();
  });

  it('backfills role: "worker" on saved profiles missing the field', () => {
    store.set({
      kanban: {
        ...store.get().kanban,
        profiles: [{ name: 'legacy', model: '', skills: [], instructions: 'x' } as never]
      }
    });
    const profiles = store.get().kanban.profiles;
    expect(profiles[0].role).toBe('worker');
  });

  it('defaults autoDecompose off and maxDecompose to 1', () => {
    const s = store.get();
    expect(s.kanban.dispatcher.autoDecompose).toBe(false);
    expect(s.kanban.dispatcher.maxDecompose).toBe(1);
  });

  it('returns kanban.pm defaults for a fresh store', () => {
    const s = store.get();
    expect(s.kanban.pm.autopilotEnabled).toBe(false);
    expect(s.kanban.pm.eventMinGapMs).toBe(30_000);
    expect(s.kanban.pm.coalesceWindowMs).toBe(2_000);
  });

  it('merges a partial pm change without dropping siblings', () => {
    store.set({
      kanban: { pm: { autopilotEnabled: true } }
    });
    const s = store.get();
    expect(s.kanban.pm.autopilotEnabled).toBe(true);
    expect(s.kanban.pm.eventMinGapMs).toBe(30_000); // sibling preserved
    expect(s.kanban.dispatcher.intervalMs).toBe(5000); // dispatcher untouched
  });
});
