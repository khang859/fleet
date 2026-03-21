import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LayoutStore } from '../layout-store';

// Mock electron-store
vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      private data: Record<string, unknown> = {};
      constructor(_opts?: unknown) {}
      get(key: string, defaultVal?: unknown) {
        return this.data[key] ?? defaultVal;
      }
      set(key: string, value: unknown) {
        this.data[key] = value;
      }
      delete(key: string) {
        delete this.data[key];
      }
    }
  };
});

describe('LayoutStore', () => {
  let store: LayoutStore;

  beforeEach(() => {
    store = new LayoutStore();
  });

  it('returns empty list when no workspaces saved', () => {
    expect(store.list()).toEqual([]);
  });

  it('saves and loads a workspace', () => {
    const workspace = {
      id: 'ws-1',
      label: 'Test',
      tabs: [
        {
          id: 'tab-1',
          label: 'Shell',
          cwd: '/tmp',
          splitRoot: { type: 'leaf' as const, id: 'pane-1', cwd: '/tmp' }
        }
      ]
    };
    store.save(workspace);
    expect(store.load('ws-1')).toEqual(workspace);
  });

  it('lists all saved workspaces', () => {
    store.save({ id: 'ws-1', label: 'A', tabs: [] });
    store.save({ id: 'ws-2', label: 'B', tabs: [] });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.id)).toEqual(['ws-1', 'ws-2']);
  });

  it('deletes a workspace', () => {
    store.save({ id: 'ws-1', label: 'A', tabs: [] });
    store.delete('ws-1');
    expect(store.load('ws-1')).toBeUndefined();
  });
});
