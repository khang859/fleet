import { describe, it, expect, vi, beforeEach } from 'vitest';
import { persistNewWorkspace } from '../create-workspace';
import type {
  LayoutSaveRequest,
  LayoutSaveResult,
  EnsureConfigDirResult
} from '../../../../shared/ipc-api';

type Fleet = {
  layout: { save: (req: LayoutSaveRequest) => Promise<LayoutSaveResult> };
  settings: {
    setWorkspaceOverride: (id: string, dir: string | null) => Promise<void>;
    ensureConfigDir: (dir: string) => Promise<EnsureConfigDirResult>;
  };
};

let fleet: Fleet;

/** Yield a microtask, the way a real IPC round trip does. */
async function roundTrip(): Promise<void> {
  await Promise.resolve();
}

/**
 * The renderer suite runs in the node environment, so `window.fleet` - which
 * only ever exists because the preload bridge put it there - is stood up by
 * hand. Only the two calls this module makes are needed.
 */
function installFleet(overrides?: Partial<Fleet>): void {
  fleet = {
    layout: {
      save: vi.fn(async (): Promise<LayoutSaveResult> => {
        await roundTrip();
        return { ok: true };
      })
    },
    settings: {
      setWorkspaceOverride: vi.fn(roundTrip),
      ensureConfigDir: vi.fn(async (): Promise<EnsureConfigDirResult> => {
        await roundTrip();
        return { ok: true };
      })
    },
    ...overrides
  };
  (globalThis as unknown as { window: { fleet: Fleet } }).window = { fleet };
}

describe('persistNewWorkspace', () => {
  beforeEach(() => {
    installFleet();
  });

  it('saves an empty workspace under the id it was given', async () => {
    const result = await persistNewWorkspace({ id: 'ws-1', name: 'Work', claudeConfigDir: null });

    expect(result).toEqual({ ok: true, workspace: { id: 'ws-1', label: 'Work', tabs: [] } });
    expect(fleet.layout.save).toHaveBeenCalledWith({
      workspace: { id: 'ws-1', label: 'Work', tabs: [] }
    });
  });

  it('writes no override when the workspace inherits the default', async () => {
    await persistNewWorkspace({ id: 'ws-1', name: 'Work', claudeConfigDir: null });
    expect(fleet.settings.setWorkspaceOverride).not.toHaveBeenCalled();
  });

  it('writes the custom folder before anything can spawn a terminal', async () => {
    const order: string[] = [];
    installFleet({
      layout: {
        save: vi.fn(async (): Promise<LayoutSaveResult> => {
          order.push('layout');
          await roundTrip();
          return { ok: true };
        })
      },
      settings: {
        setWorkspaceOverride: vi.fn(async () => {
          order.push('override');
          await roundTrip();
        }),
        ensureConfigDir: vi.fn(async (): Promise<EnsureConfigDirResult> => {
          order.push('mkdir');
          await roundTrip();
          return { ok: true };
        })
      }
    });

    await persistNewWorkspace({ id: 'ws-1', name: 'Work', claudeConfigDir: '/work/.claude' });

    expect(order).toEqual(['mkdir', 'layout', 'override']);
    expect(fleet.settings.setWorkspaceOverride).toHaveBeenCalledWith('ws-1', '/work/.claude');
  });

  it('reports a failed layout save instead of claiming success', async () => {
    installFleet({
      layout: {
        save: vi.fn(async (): Promise<LayoutSaveResult> => {
          await roundTrip();
          return { ok: false, error: 'disk full' };
        })
      }
    });

    const result = await persistNewWorkspace({ id: 'ws-1', name: 'Work', claudeConfigDir: null });

    expect(result).toEqual({ ok: false, error: 'disk full', savedLayout: false });
    expect(fleet.settings.setWorkspaceOverride).not.toHaveBeenCalled();
  });

  it('distinguishes a saved workspace whose folder choice failed', async () => {
    installFleet({
      settings: {
        setWorkspaceOverride: vi.fn(async () => {
          await roundTrip();
          throw new Error('settings locked');
        }),
        ensureConfigDir: vi.fn(async (): Promise<EnsureConfigDirResult> => {
          await roundTrip();
          return { ok: true };
        })
      }
    });

    const result = await persistNewWorkspace({
      id: 'ws-1',
      name: 'Work',
      claudeConfigDir: '/work/.claude'
    });

    expect(result).toEqual({ ok: false, error: 'settings locked', savedLayout: true });
  });

  it('creates one workspace, not two, when a failed submission is retried', async () => {
    let attempt = 0;
    installFleet({
      layout: {
        save: vi.fn(async (): Promise<LayoutSaveResult> => {
          attempt += 1;
          await roundTrip();
          return attempt === 1 ? { ok: false, error: 'busy' } : { ok: true };
        })
      }
    });

    const draft = { id: 'ws-1', name: 'Work', claudeConfigDir: null };
    const first = await persistNewWorkspace(draft);
    const second = await persistNewWorkspace(draft);

    expect(first.ok).toBe(false);
    expect(second).toEqual({ ok: true, workspace: { id: 'ws-1', label: 'Work', tabs: [] } });
    // Same id both times, so the retry overwrites the failed attempt rather
    // than leaving a second workspace behind.
    const saves = vi.mocked(fleet.layout.save).mock.calls;
    expect(saves.map(([req]) => req.workspace.id)).toEqual(['ws-1', 'ws-1']);
  });

  it('creates the custom folder before writing anything', async () => {
    await persistNewWorkspace({ id: 'ws-1', name: 'Work', claudeConfigDir: '/work/.claude-work' });
    expect(fleet.settings.ensureConfigDir).toHaveBeenCalledWith('/work/.claude-work');
  });

  it('touches no folder when the workspace inherits the default', async () => {
    await persistNewWorkspace({ id: 'ws-1', name: 'Work', claudeConfigDir: null });
    expect(fleet.settings.ensureConfigDir).not.toHaveBeenCalled();
  });

  it('saves nothing when the folder cannot be created', async () => {
    installFleet({
      settings: {
        setWorkspaceOverride: vi.fn(roundTrip),
        ensureConfigDir: vi.fn(async (): Promise<EnsureConfigDirResult> => {
          await roundTrip();
          return { ok: false, error: 'read-only volume' };
        })
      }
    });

    const result = await persistNewWorkspace({
      id: 'ws-1',
      name: 'Work',
      claudeConfigDir: '/work/.claude-work'
    });

    expect(result).toEqual({
      ok: false,
      error: 'folder could not be created: read-only volume',
      savedLayout: false
    });
    // Nothing half-written: no workspace to clean up after a bad path.
    expect(fleet.layout.save).not.toHaveBeenCalled();
  });
});
