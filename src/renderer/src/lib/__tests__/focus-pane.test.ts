import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useWorkspaceStore } from '../../store/workspace-store';
import { focusPane } from '../focus-pane';
import type { Tab, Workspace } from '../../../../shared/types';

function tab(id: string, paneIds: [string] | [string, string]): Tab {
  const leaf = (paneId: string) => ({ type: 'leaf' as const, id: paneId, cwd: '/repo' });
  return {
    id,
    label: id,
    labelIsCustom: false,
    cwd: '/repo',
    splitRoot:
      paneIds.length === 1
        ? leaf(paneIds[0])
        : {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            children: [leaf(paneIds[0]), leaf(paneIds[1])]
          }
  };
}

const CURRENT: Workspace = {
  id: 'ws-current',
  label: 'Current',
  tabs: [tab('tab-1', ['pane-1']), tab('tab-2', ['pane-2a', 'pane-2b'])]
};
const BACKGROUND: Workspace = {
  id: 'ws-bg',
  label: 'Background',
  tabs: [tab('tab-bg', ['pane-bg'])]
};

let refocused: string[];
let saved: Workspace[];

beforeEach(() => {
  refocused = [];
  saved = [];
  // The renderer suite runs under node: stand up the few browser globals used.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    cb();
    return 0;
  });
  vi.stubGlobal('document', {
    dispatchEvent: (e: CustomEvent<{ paneId: string }>) => {
      refocused.push(e.detail.paneId);
      return true;
    }
  });
  vi.stubGlobal('window', {
    fleet: {
      homeDir: '/home/u',
      layout: {
        save: vi.fn(async ({ workspace }: { workspace: Workspace }) => {
          saved.push(workspace);
          return Promise.resolve({ ok: true });
        }),
        load: vi.fn(async () => Promise.resolve(null))
      }
    }
  });
  useWorkspaceStore.setState({
    workspace: CURRENT,
    activeTabId: 'tab-1',
    activePaneId: 'pane-1',
    backgroundWorkspaces: new Map([[BACKGROUND.id, BACKGROUND]])
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('focusPane', () => {
  it('activates the tab and pane in the current workspace and focuses it', async () => {
    expect(await focusPane('pane-2b')).toBe(true);
    const state = useWorkspaceStore.getState();
    expect(state.activeTabId).toBe('tab-2');
    // The pane itself, not the first pane of its tab.
    expect(state.activePaneId).toBe('pane-2b');
    expect(refocused).toEqual(['pane-2b']);
    expect(saved).toEqual([]);
  });

  it('switches to the background workspace that runs the pane', async () => {
    expect(await focusPane('pane-bg')).toBe(true);
    const state = useWorkspaceStore.getState();
    expect(state.workspace.id).toBe('ws-bg');
    expect(state.activeTabId).toBe('tab-bg');
    expect(state.activePaneId).toBe('pane-bg');
    expect(refocused).toEqual(['pane-bg']);
    // The workspace left behind was saved first.
    expect(saved.map((w) => w.id)).toEqual(['ws-current']);
  });

  it('does nothing for a pane no open workspace has', async () => {
    expect(await focusPane('pane-gone')).toBe(false);
    expect(useWorkspaceStore.getState().activePaneId).toBe('pane-1');
    expect(refocused).toEqual([]);
  });
});
