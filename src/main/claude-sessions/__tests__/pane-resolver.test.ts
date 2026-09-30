import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneResolver, type PaneHost, type WorkspaceInfo } from '../pane-resolver';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

describe('PaneResolver', () => {
  // pane-1's shell is pid 100; Claude (500) runs under a wrapper (400) under that shell.
  let shells: Map<string, number>;
  let parents: Map<number, number>;
  let workspaces: Map<string, WorkspaceInfo>;
  let parentOf: ReturnType<typeof vi.fn<(pid: number) => number | null>>;
  let workspaceOf: ReturnType<typeof vi.fn<(paneId: string) => WorkspaceInfo | null>>;
  let resolver: PaneResolver;

  beforeEach(() => {
    shells = new Map([
      ['pane-1', 100],
      ['pane-2', 200]
    ]);
    parents = new Map([
      [500, 400],
      [400, 100],
      [100, 1],
      [900, 1]
    ]);
    workspaces = new Map([['pane-1', { workspaceId: 'ws-1', workspaceName: 'Main' }]]);
    const host: PaneHost = {
      has: (id) => shells.has(id),
      paneIds: () => [...shells.keys()],
      getPid: (id) => shells.get(id)
    };
    parentOf = vi.fn((pid: number) => parents.get(pid) ?? null);
    workspaceOf = vi.fn((paneId: string) => workspaces.get(paneId) ?? null);
    resolver = new PaneResolver(host, workspaceOf, parentOf);
  });

  it('trusts a pane id this instance owns without walking processes', () => {
    expect(resolver.resolve({ paneId: 'pane-2', pid: 500 })).toEqual({ paneId: 'pane-2' });
    expect(parentOf).not.toHaveBeenCalled();
  });

  it('falls back to the process walk for a pane id it does not own', () => {
    expect(resolver.resolve({ paneId: 'pane-from-elsewhere', pid: 500 })).toMatchObject({
      paneId: 'pane-1'
    });
  });

  it('finds the pane through the parent processes when no id is sent', () => {
    expect(resolver.resolve({ pid: 500 })).toEqual({
      paneId: 'pane-1',
      workspaceId: 'ws-1',
      workspaceName: 'Main'
    });
  });

  it('caches a hit', () => {
    resolver.resolve({ pid: 500 });
    parentOf.mockClear();
    expect(resolver.resolve({ pid: 500 })?.paneId).toBe('pane-1');
    expect(parentOf).not.toHaveBeenCalled();
  });

  it('does not cache a miss, so a later event can still be placed', () => {
    expect(resolver.resolve({ pid: 900 })).toBeNull();
    parents.set(900, 300);
    shells.set('pane-3', 300);
    expect(resolver.resolve({ pid: 900 })?.paneId).toBe('pane-3');
  });

  it('drops a cached hit once its pane is gone', () => {
    resolver.resolve({ pid: 500 });
    shells.delete('pane-1');
    expect(resolver.resolve({ pid: 500 })).toBeNull();
  });

  it('returns null with neither a known pane nor a pid', () => {
    expect(resolver.resolve({})).toBeNull();
    expect(resolver.resolve({ paneId: 'nope' })).toBeNull();
  });

  it('retries the workspace lookup until the layout knows the pane, then caches it', () => {
    expect(resolver.resolve({ paneId: 'pane-2' })).toEqual({ paneId: 'pane-2' });
    workspaces.set('pane-2', { workspaceId: 'ws-2', workspaceName: 'Side' });
    expect(resolver.resolve({ paneId: 'pane-2' })).toMatchObject({ workspaceId: 'ws-2' });
    workspaceOf.mockClear();
    resolver.resolve({ paneId: 'pane-2' });
    expect(workspaceOf).not.toHaveBeenCalled();
  });

  it('forgets a closed pane', () => {
    resolver.resolve({ pid: 500 });
    resolver.forgetPane('pane-1');
    workspaceOf.mockClear();
    parentOf.mockClear();
    resolver.resolve({ pid: 500 });
    expect(parentOf).toHaveBeenCalled();
    expect(workspaceOf).toHaveBeenCalled();
  });
});
