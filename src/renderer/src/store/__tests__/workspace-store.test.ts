import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore, collectPaneLeafs } from '../workspace-store';
import { useCwdStore } from '../cwd-store';
import type { Workspace } from '../../../../shared/types';

const WS_A: Workspace = {
  id: 'ws-a',
  label: 'Alpha',
  tabs: [
    {
      id: 'tab-a1',
      label: 'Shell',
      labelIsCustom: false,
      cwd: '/tmp',
      splitRoot: { type: 'leaf', id: 'pane-a1', cwd: '/tmp' }
    }
  ]
};

const WS_B: Workspace = {
  id: 'ws-b',
  label: 'Beta',
  tabs: [
    {
      id: 'tab-b1',
      label: 'Shell',
      labelIsCustom: false,
      cwd: '/home',
      splitRoot: { type: 'leaf', id: 'pane-b1', cwd: '/home' }
    }
  ]
};

const WS_C: Workspace = {
  id: 'ws-c',
  label: 'Gamma',
  tabs: [
    {
      id: 'tab-c1',
      label: 'Shell',
      labelIsCustom: false,
      cwd: '/',
      splitRoot: { type: 'leaf', id: 'pane-c1', cwd: '/' }
    }
  ]
};

beforeEach(() => {
  useWorkspaceStore.setState({
    workspace: WS_A,
    backgroundWorkspaces: new Map(),
    activeTabId: 'tab-a1',
    activePaneId: 'pane-a1',
    isDirty: false,
    lastClosedTab: null,
    recentFiles: []
  });
  useCwdStore.setState({ cwds: new Map() });
});

describe('switchWorkspace', () => {
  it('activates the new workspace', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    expect(useWorkspaceStore.getState().workspace.id).toBe('ws-b');
  });

  it('moves the current workspace to background', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    expect(useWorkspaceStore.getState().backgroundWorkspaces.has('ws-a')).toBe(true);
  });

  it('removes the target workspace from background', () => {
    useWorkspaceStore.setState({ backgroundWorkspaces: new Map([['ws-b', WS_B]]) });
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    expect(useWorkspaceStore.getState().backgroundWorkspaces.has('ws-b')).toBe(false);
  });

  it('sets activeTabId and activePaneId to first pane of new workspace', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    const state = useWorkspaceStore.getState();
    expect(state.activeTabId).toBe('tab-b1');
    expect(state.activePaneId).toBe('pane-b1');
  });

  it('prefers in-memory background workspace over provided ws argument', () => {
    const modifiedB: Workspace = { ...WS_B, label: 'Beta Modified' };
    useWorkspaceStore.setState({ backgroundWorkspaces: new Map([['ws-b', modifiedB]]) });
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    expect(useWorkspaceStore.getState().workspace.label).toBe('Beta Modified');
  });

  it('switching back restores the previously backgrounded workspace', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    useWorkspaceStore.getState().switchWorkspace(WS_A);
    const state = useWorkspaceStore.getState();
    expect(state.workspace.id).toBe('ws-a');
    expect(state.backgroundWorkspaces.has('ws-b')).toBe(true);
    expect(state.backgroundWorkspaces.has('ws-a')).toBe(false);
  });

  it('supports 3+ workspace switches without losing any background workspace', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    useWorkspaceStore.getState().switchWorkspace(WS_C);
    const state = useWorkspaceStore.getState();
    expect(state.workspace.id).toBe('ws-c');
    expect(state.backgroundWorkspaces.has('ws-a')).toBe(true);
    expect(state.backgroundWorkspaces.has('ws-b')).toBe(true);
  });

  it('sets activeTabId to null for an empty workspace', () => {
    const emptyWs: Workspace = { id: 'ws-empty', label: 'Empty', tabs: [] };
    useWorkspaceStore.getState().switchWorkspace(emptyWs);
    expect(useWorkspaceStore.getState().activeTabId).toBeNull();
    expect(useWorkspaceStore.getState().activePaneId).toBeNull();
  });
});

describe('loadBackgroundWorkspaces', () => {
  it('loads workspaces into background without affecting the active workspace', () => {
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_B]);
    const state = useWorkspaceStore.getState();
    expect(state.workspace.id).toBe('ws-a');
    expect(state.backgroundWorkspaces.has('ws-b')).toBe(true);
  });

  it('does not overwrite an already-loaded background workspace', () => {
    const modifiedB: Workspace = { ...WS_B, label: 'Already Loaded' };
    useWorkspaceStore.setState({ backgroundWorkspaces: new Map([['ws-b', modifiedB]]) });
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_B]);
    expect(useWorkspaceStore.getState().backgroundWorkspaces.get('ws-b')?.label).toBe(
      'Already Loaded'
    );
  });

  it('does not load the active workspace as a background workspace', () => {
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_A]);
    expect(useWorkspaceStore.getState().backgroundWorkspaces.has('ws-a')).toBe(false);
  });

  it('loads multiple workspaces in a single call', () => {
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_B, WS_C]);
    const state = useWorkspaceStore.getState();
    expect(state.backgroundWorkspaces.has('ws-b')).toBe(true);
    expect(state.backgroundWorkspaces.has('ws-c')).toBe(true);
  });
});

describe('getAllPaneIds', () => {
  it('returns only active pane IDs when no background workspaces', () => {
    const ids = useWorkspaceStore.getState().getAllPaneIds();
    expect(ids).toEqual(['pane-a1']);
  });

  it('includes background workspace pane IDs', () => {
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_B]);
    const ids = useWorkspaceStore.getState().getAllPaneIds();
    expect(ids).toContain('pane-a1');
    expect(ids).toContain('pane-b1');
  });

  it('includes all background pane IDs after multiple workspace switches', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    useWorkspaceStore.getState().switchWorkspace(WS_C);
    const ids = useWorkspaceStore.getState().getAllPaneIds();
    expect(ids).toContain('pane-a1'); // ws-a is background
    expect(ids).toContain('pane-b1'); // ws-b is background
    expect(ids).toContain('pane-c1'); // ws-c is active
  });

  it('GC allowlist covers all workspace panes — no background PTY is killed', () => {
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_B, WS_C]);
    const ids = new Set(useWorkspaceStore.getState().getAllPaneIds());
    // All pane IDs across all workspaces are in the GC allowlist
    expect(ids.has('pane-a1')).toBe(true);
    expect(ids.has('pane-b1')).toBe(true);
    expect(ids.has('pane-c1')).toBe(true);
  });
});

describe('loadWorkspace — active tab/pane restoration', () => {
  it('restores the persisted activeTabId when it matches a real tab', () => {
    const ws: Workspace = {
      id: 'ws-x',
      label: 'X',
      activeTabId: 'tab-x2',
      tabs: [
        {
          id: 'tab-x1',
          label: 'A',
          labelIsCustom: false,
          cwd: '/',
          splitRoot: { type: 'leaf', id: 'pane-x1', cwd: '/' }
        },
        {
          id: 'tab-x2',
          label: 'B',
          labelIsCustom: false,
          cwd: '/',
          splitRoot: { type: 'leaf', id: 'pane-x2', cwd: '/' }
        }
      ]
    };
    useWorkspaceStore.getState().loadWorkspace(ws);
    expect(useWorkspaceStore.getState().activeTabId).toBe('tab-x2');
  });

  it('falls back to tabs[0] when persisted activeTabId is not found', () => {
    const ws: Workspace = {
      id: 'ws-x',
      label: 'X',
      activeTabId: 'tab-gone',
      tabs: [
        {
          id: 'tab-x1',
          label: 'A',
          labelIsCustom: false,
          cwd: '/',
          splitRoot: { type: 'leaf', id: 'pane-x1', cwd: '/' }
        }
      ]
    };
    useWorkspaceStore.getState().loadWorkspace(ws);
    expect(useWorkspaceStore.getState().activeTabId).toBe('tab-x1');
  });

  it('restores the persisted activePaneId when it is in the active tab', () => {
    const ws: Workspace = {
      id: 'ws-x',
      label: 'X',
      activeTabId: 'tab-x1',
      activePaneId: 'pane-x1',
      tabs: [
        {
          id: 'tab-x1',
          label: 'A',
          labelIsCustom: false,
          cwd: '/',
          splitRoot: { type: 'leaf', id: 'pane-x1', cwd: '/' }
        }
      ]
    };
    useWorkspaceStore.getState().loadWorkspace(ws);
    expect(useWorkspaceStore.getState().activePaneId).toBe('pane-x1');
  });

  it('falls back to first pane when persisted activePaneId is not in active tab', () => {
    const ws: Workspace = {
      id: 'ws-x',
      label: 'X',
      activePaneId: 'pane-gone',
      tabs: [
        {
          id: 'tab-x1',
          label: 'A',
          labelIsCustom: false,
          cwd: '/',
          splitRoot: { type: 'leaf', id: 'pane-x1', cwd: '/' }
        }
      ]
    };
    useWorkspaceStore.getState().loadWorkspace(ws);
    expect(useWorkspaceStore.getState().activePaneId).toBe('pane-x1');
  });
});

describe('switchWorkspace — active tab/pane restoration', () => {
  it('restores persisted activeTabId from in-memory background workspace (non-first tab)', () => {
    // WS_B has only one tab, so tab-b1 would be tabs[0] regardless.
    // Use a multi-tab variant with activeTabId pointing to the SECOND tab so
    // the old code (always picks tabs[0]) will fail this test.
    const wsBMulti: Workspace = {
      id: 'ws-b',
      label: 'Beta',
      activeTabId: 'tab-b2',
      tabs: [
        {
          id: 'tab-b1',
          label: 'A',
          labelIsCustom: false,
          cwd: '/',
          splitRoot: { type: 'leaf', id: 'pane-b1', cwd: '/' }
        },
        {
          id: 'tab-b2',
          label: 'B',
          labelIsCustom: false,
          cwd: '/',
          splitRoot: { type: 'leaf', id: 'pane-b2', cwd: '/' }
        }
      ]
    };
    useWorkspaceStore.setState({ backgroundWorkspaces: new Map([['ws-b', wsBMulti]]) });
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    expect(useWorkspaceStore.getState().activeTabId).toBe('tab-b2');
  });

  it('stashes old workspace with current activeTabId into backgroundWorkspaces', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    const stashed = useWorkspaceStore.getState().backgroundWorkspaces.get('ws-a');
    expect(stashed?.activeTabId).toBe('tab-a1');
  });
});

describe('switchWorkspace — stashes live CWDs', () => {
  it('injects live CWDs into the old workspace before stashing', () => {
    // Prime cwd-store with a live CWD for pane-a1
    useCwdStore.setState({ cwds: new Map([['pane-a1', '/live/a1']]) });

    useWorkspaceStore.getState().switchWorkspace(WS_B);

    const stashed = useWorkspaceStore.getState().backgroundWorkspaces.get('ws-a');
    const leaf = stashed?.tabs[0].splitRoot;
    expect(leaf?.type === 'leaf' ? leaf.cwd : null).toBe('/live/a1');
  });
});

describe('closeTab — live CWD for undo', () => {
  it('injects live CWD into lastClosedTab so undo restores at the correct directory', () => {
    // Prime live CWD for pane-a1 (different from the stored /tmp)
    useCwdStore.setState({ cwds: new Map([['pane-a1', '/live/undo-path']]) });

    useWorkspaceStore.getState().closeTab('tab-a1');

    const { lastClosedTab } = useWorkspaceStore.getState();
    const leaf = lastClosedTab?.tab.splitRoot;
    expect(leaf?.type === 'leaf' ? leaf.cwd : null).toBe('/live/undo-path');
  });

  it('keeps original CWD when no live CWD is in cwd-store', () => {
    useCwdStore.setState({ cwds: new Map() });

    useWorkspaceStore.getState().closeTab('tab-a1');

    const { lastClosedTab } = useWorkspaceStore.getState();
    const leaf = lastClosedTab?.tab.splitRoot;
    expect(leaf?.type === 'leaf' ? leaf.cwd : null).toBe('/tmp'); // WS_A tab's original CWD
  });
});

describe('splitPane — live CWD', () => {
  it('uses the live CWD from cwd-store for the new pane', () => {
    // Prime cwd-store with a different CWD than what's in the tab
    useCwdStore.setState({ cwds: new Map([['pane-a1', '/live/path']]) });

    const newPaneId = useWorkspaceStore.getState().splitPane('pane-a1', 'horizontal');

    // Find the new leaf's CWD via collectPaneLeafs
    const tab = useWorkspaceStore.getState().workspace.tabs[0];
    const leaves = collectPaneLeafs(tab.splitRoot);
    const newLeaf = leaves.find((l) => l.id === newPaneId);
    expect(newLeaf?.cwd).toBe('/live/path');
  });

  it('falls back to tab.cwd when no live CWD in cwd-store', () => {
    useCwdStore.setState({ cwds: new Map() });

    const newPaneId = useWorkspaceStore.getState().splitPane('pane-a1', 'horizontal');

    const tab = useWorkspaceStore.getState().workspace.tabs[0];
    const leaves = collectPaneLeafs(tab.splitRoot);
    const newLeaf = leaves.find((l) => l.id === newPaneId);
    expect(newLeaf?.cwd).toBe('/tmp'); // WS_A's tab cwd
  });
});
