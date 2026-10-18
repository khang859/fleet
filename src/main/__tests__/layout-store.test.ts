import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LayoutStore } from '../layout-store';

// Mock electron-store
vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      private data: Record<string, unknown> = {};
      constructor() {}
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
          labelIsCustom: false,
          cwd: '/tmp',
          splitRoot: { type: 'leaf' as const, id: 'pane-1', cwd: '/tmp' }
        }
      ]
    };
    store.save(workspace);
    expect(store.load('ws-1')).toEqual(workspace);
  });

  it('round-trips an Admiral tab with its repository and thread sessions', () => {
    const workspace = {
      id: 'ws-1',
      label: 'Test',
      tabs: [
        {
          id: 'tab-1',
          label: 'Admiral · fleet',
          labelIsCustom: true,
          cwd: '/src/fleet',
          type: 'agent' as const,
          splitRoot: {
            type: 'leaf' as const,
            id: 'pane-1',
            cwd: '/src/fleet',
            paneType: 'admiral' as const,
            admiralRepo: { repoId: '0123456789abcdef', root: '/src/fleet', name: 'fleet' },
            admiralSessions: { lobby: 'lobby-session', jobs: { '3': 'job-3-session' } },
            admiralActiveJob: 3
          }
        }
      ]
    };
    store.save(workspace);
    expect(JSON.parse(JSON.stringify(store.load('ws-1')))).toEqual(workspace);
  });

  it('lists all saved workspaces', () => {
    store.save({ id: 'ws-1', label: 'A', tabs: [] });
    store.save({ id: 'ws-2', label: 'B', tabs: [] });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.id)).toEqual(['ws-1', 'ws-2']);
  });

  it('drops the job tabs, whose crew panes end with Fleet, and keeps the rest', () => {
    const tab = (id: string, agencyJobId?: number) => ({
      id,
      label: id,
      labelIsCustom: false,
      cwd: '/tmp',
      splitRoot: { type: 'leaf' as const, id: `pane-${id}`, cwd: '/tmp' },
      ...(agencyJobId === undefined ? {} : { agencyJobId })
    });
    store.save({ id: 'ws-1', label: 'A', tabs: [tab('shell'), tab('j4', 4)], activeTabId: 'j4' });
    store.save({ id: 'ws-2', label: 'B', tabs: [tab('j5', 5)] });
    store.dropJobTabs();
    expect(store.load('ws-1')?.tabs.map((t) => t.id)).toEqual(['shell']);
    expect(store.load('ws-2')?.tabs).toEqual([]);
  });

  it('deletes a workspace', () => {
    store.save({ id: 'ws-1', label: 'A', tabs: [] });
    store.delete('ws-1');
    expect(store.load('ws-1')).toBeUndefined();
  });
});
