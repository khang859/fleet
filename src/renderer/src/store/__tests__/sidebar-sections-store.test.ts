import { describe, it, expect, beforeEach, vi } from 'vitest';

const STORAGE_KEY = 'fleet.sidebar-sections';

let store: Record<string, string>;

beforeEach(() => {
  store = {};
  vi.resetModules();
  // The store reads localStorage at module init, so each case needs a fresh
  // import against a fresh backing object.
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    }
  };
});

async function freshStore() {
  const mod = await import('../sidebar-sections-store');
  return mod.useSidebarSectionsStore;
}

describe('useSidebarSectionsStore', () => {
  it('starts with every section expanded when nothing is stored', async () => {
    const useStore = await freshStore();
    expect(useStore.getState().collapsed.size).toBe(0);
  });

  it('toggle() collapses a section and writes it through', async () => {
    const useStore = await freshStore();
    useStore.getState().toggle('tools');
    expect(useStore.getState().collapsed.has('tools')).toBe(true);
    expect(store[STORAGE_KEY]).toBe('["tools"]');
  });

  it('toggle() expands again and removes it from storage', async () => {
    const useStore = await freshStore();
    useStore.getState().toggle('tools');
    useStore.getState().toggle('tools');
    expect(useStore.getState().collapsed.has('tools')).toBe(false);
    expect(store[STORAGE_KEY]).toBe('[]');
  });

  it('restores what was stored', async () => {
    store[STORAGE_KEY] = '["agents","workspaces"]';
    const useStore = await freshStore();
    expect([...useStore.getState().collapsed].sort()).toEqual(['agents', 'workspaces']);
  });

  it('drops ids it does not recognise but keeps the rest', async () => {
    // A section removed in a later version must not reset the other choices.
    store[STORAGE_KEY] = '["agents","kanban"]';
    const useStore = await freshStore();
    expect([...useStore.getState().collapsed]).toEqual(['agents']);
  });

  it('falls back to expanded on malformed storage', async () => {
    store[STORAGE_KEY] = 'not json';
    const useStore = await freshStore();
    expect(useStore.getState().collapsed.size).toBe(0);
  });

  it('falls back to expanded when the stored value is the wrong shape', async () => {
    store[STORAGE_KEY] = '{"tools":true}';
    const useStore = await freshStore();
    expect(useStore.getState().collapsed.size).toBe(0);
  });

  it('expand() opens a collapsed section', async () => {
    const useStore = await freshStore();
    useStore.getState().toggle('workspaces');
    useStore.getState().expand('workspaces');
    expect(useStore.getState().collapsed.has('workspaces')).toBe(false);
  });

  it('expand() leaves an already-open section alone without writing', async () => {
    const useStore = await freshStore();
    const before = useStore.getState().collapsed;
    useStore.getState().expand('workspaces');
    expect(useStore.getState().collapsed).toBe(before);
    expect(store[STORAGE_KEY]).toBeUndefined();
  });

  it('survives localStorage throwing', async () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      }
    };
    const useStore = await freshStore();
    expect(useStore.getState().collapsed.size).toBe(0);
    expect(() => useStore.getState().toggle('tools')).not.toThrow();
    expect(useStore.getState().collapsed.has('tools')).toBe(true);
  });
});
