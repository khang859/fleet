import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsStore } from '../settings-store';
import type { FleetSettings } from '../../shared/types';

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

describe('SettingsStore kanban merge', () => {
  let store: SettingsStore;
  beforeEach(() => {
    store = new SettingsStore();
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
    } as unknown as Partial<FleetSettings>);
    const s = store.get();
    expect(s.kanban.dispatcher.intervalMs).toBe(3000);
    expect(s.kanban.dispatcher.maxInProgress).toBe(3); // sibling preserved
    expect(s.kanban.profiles.length).toBeGreaterThan(0); // profiles preserved
  });

  it('replaces the profiles array wholesale when provided', () => {
    store.set({
      kanban: { profiles: [{ name: 'solo', model: '', skills: [], instructions: 'x' }] }
    } as unknown as Partial<FleetSettings>);
    expect(store.get().kanban.profiles.map((p) => p.name)).toEqual(['solo']);
  });

  it('merges a partial defaults change without dropping maxRuntimeSeconds', () => {
    store.set({
      kanban: { defaults: { workspaceKind: 'dir' } }
    } as unknown as Partial<FleetSettings>);
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
});
