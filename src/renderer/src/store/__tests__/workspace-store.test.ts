import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore, collectPaneLeafs, agentSessionsInUse } from '../workspace-store';
import { useCwdStore } from '../cwd-store';
import type { Workspace } from '../../../../shared/types';

const IMAGES_TAB_A = {
  id: 'tab-img-a',
  label: 'Images',
  labelIsCustom: true,
  cwd: '/tmp',
  type: 'images' as const,
  splitRoot: { type: 'leaf' as const, id: 'pane-img-a', cwd: '/tmp' }
};

const IMAGES_TAB_B = {
  id: 'tab-img-b',
  label: 'Images',
  labelIsCustom: true,
  cwd: '/home',
  type: 'images' as const,
  splitRoot: { type: 'leaf' as const, id: 'pane-img-b', cwd: '/home' }
};

const IMAGES_TAB_C = {
  id: 'tab-img-c',
  label: 'Images',
  labelIsCustom: true,
  cwd: '/',
  type: 'images' as const,
  splitRoot: { type: 'leaf' as const, id: 'pane-img-c', cwd: '/' }
};

const WS_A: Workspace = {
  id: 'ws-a',
  label: 'Alpha',
  tabs: [
    IMAGES_TAB_A,
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
    IMAGES_TAB_B,
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
    IMAGES_TAB_C,
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
  // setToolVisible persists visibility through the settings bridge with a
  // fire-and-forget updateSettings; the bare window.fleet stub from test-setup
  // would make that call reject unhandled and fail the run.
  (window.fleet as { settings: unknown }).settings = {
    set: async () => undefined,
    get: async () => ({})
  };
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

  it('ensures only the default-visible tool (annotate) for an empty workspace', () => {
    const emptyWs: Workspace = { id: 'ws-empty', label: 'Empty', tabs: [] };
    useWorkspaceStore.getState().switchWorkspace(emptyWs);
    const state = useWorkspaceStore.getState();
    // Default tool visibility is annotate-only; other tools are opt-in.
    expect(state.workspace.tabs).toHaveLength(1);
    expect(state.workspace.tabs[0].type).toBe('annotate');
  });

  it('strips a disabled tool tab and recreates it when re-enabled', () => {
    const emptyWs: Workspace = { id: 'ws-vis', label: 'Visibility', tabs: [] };
    useWorkspaceStore.getState().switchWorkspace(emptyWs);
    // Enabling kanban adds its pinned tab...
    useWorkspaceStore.getState().setToolVisible('kanban', true);
    expect(useWorkspaceStore.getState().workspace.tabs.some((t) => t.type === 'kanban')).toBe(true);
    // ...and disabling it strips the tab again.
    useWorkspaceStore.getState().setToolVisible('kanban', false);
    expect(useWorkspaceStore.getState().workspace.tabs.some((t) => t.type === 'kanban')).toBe(
      false
    );
  });

  it('strips the now-defunct pinned Artifacts tab from a persisted workspace', () => {
    const wsWithArtifacts: Workspace = {
      id: 'ws-art',
      label: 'Legacy',
      tabs: [
        {
          id: 'tab-art',
          label: 'Artifacts',
          labelIsCustom: true,
          cwd: '/home',
          type: 'artifacts',
          splitRoot: { type: 'leaf', id: 'leaf-art', cwd: '/home', paneType: 'artifacts' }
        }
      ]
    };
    useWorkspaceStore.getState().switchWorkspace(wsWithArtifacts);
    const state = useWorkspaceStore.getState();
    expect(state.workspace.tabs.some((t) => t.type === 'artifacts')).toBe(false);
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
    expect(ids).toContain('pane-a1');
    expect(ids).toContain('pane-img-a');
    expect(ids).toHaveLength(2);
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

/**
 * The Sessions list asks this before it offers to delete a log: a session two
 * panes are both holding is one another pane is still writing to.
 */
describe('agentSessionsInUse', () => {
  const withAgentPanes = (...sessionIds: Array<string | undefined>): void => {
    useWorkspaceStore.setState({
      workspace: {
        ...WS_A,
        tabs: sessionIds.map((agentSessionId, i) => ({
          id: `tab-agent-${i}`,
          label: 'Agent',
          labelIsCustom: false,
          cwd: '/tmp',
          splitRoot: {
            type: 'leaf' as const,
            id: `pane-agent-${i}`,
            cwd: '/tmp',
            paneType: 'agent' as const,
            agentSessionId
          }
        }))
      }
    });
  };

  it('finds the session behind every agent pane, in every tab', () => {
    withAgentPanes('sess-1', 'sess-2');

    expect(agentSessionsInUse()).toEqual(new Set(['sess-1', 'sess-2']));
  });

  it('passes over panes that are not on a session', () => {
    withAgentPanes('sess-1', undefined);

    expect(agentSessionsInUse()).toEqual(new Set(['sess-1']));
  });

  it('reaches panes inside a split, not only the tab root', () => {
    useWorkspaceStore.setState({
      workspace: {
        ...WS_A,
        tabs: [
          {
            id: 'tab-split',
            label: 'Split',
            labelIsCustom: false,
            cwd: '/tmp',
            splitRoot: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.5,
              children: [
                { type: 'leaf', id: 'pane-l', cwd: '/tmp', agentSessionId: 'sess-left' },
                { type: 'leaf', id: 'pane-r', cwd: '/tmp', agentSessionId: 'sess-right' }
              ]
            }
          }
        ]
      }
    });

    expect(agentSessionsInUse()).toEqual(new Set(['sess-left', 'sess-right']));
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
    const shellTab = stashed?.tabs.find((t) => t.id === 'tab-a1');
    const leaf = shellTab?.splitRoot;
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

describe('closeWorktreeTab — dissolved group', () => {
  const DISSOLVED_WORKTREE_TAB = {
    id: 'tab-wt1',
    label: 'feature-branch',
    labelIsCustom: true,
    cwd: '/repo-wt',
    worktreeBranch: 'feature-branch',
    worktreePath: '/repo-wt',
    splitRoot: { type: 'leaf' as const, id: 'pane-wt1', cwd: '/repo-wt' }
  };

  beforeEach(() => {
    useWorkspaceStore.setState({
      workspace: { ...WS_A, tabs: [...WS_A.tabs, DISSOLVED_WORKTREE_TAB] },
      activeTabId: 'tab-wt1',
      activePaneId: 'pane-wt1'
    });
  });

  it('closes a worktree tab whose group already dissolved (no groupId)', () => {
    useWorkspaceStore.getState().closeWorktreeTab('tab-wt1');

    const { workspace, lastClosedTab } = useWorkspaceStore.getState();
    expect(workspace.tabs.some((t) => t.id === 'tab-wt1')).toBe(false);
    expect(lastClosedTab?.tab.id).toBe('tab-wt1');
  });
});

describe('closePane — worktree tab last pane', () => {
  const WORKTREE_TAB = {
    id: 'tab-wt2',
    label: 'feature-branch',
    labelIsCustom: true,
    cwd: '/repo-wt2',
    worktreeBranch: 'feature-branch',
    worktreePath: '/repo-wt2',
    splitRoot: { type: 'leaf' as const, id: 'pane-wt2', cwd: '/repo-wt2' }
  };

  beforeEach(() => {
    useWorkspaceStore.setState({
      workspace: { ...WS_A, tabs: [...WS_A.tabs, WORKTREE_TAB] },
      activeTabId: 'tab-wt2',
      activePaneId: 'pane-wt2',
      worktreeCloseConfirm: null
    });
  });

  it('routes to the worktree close confirmation instead of silently dropping the tab', () => {
    useWorkspaceStore.getState().closePane('pane-wt2');

    const state = useWorkspaceStore.getState();
    expect(state.workspace.tabs.some((t) => t.id === 'tab-wt2')).toBe(true);
    expect(state.worktreeCloseConfirm).toEqual({ tabId: 'tab-wt2', label: 'feature-branch' });
  });

  it('leaves non-worktree panes closeable as before', () => {
    useWorkspaceStore.getState().closePane('pane-a1');

    const state = useWorkspaceStore.getState();
    expect(state.workspace.tabs.some((t) => t.id === 'tab-a1')).toBe(false);
    expect(state.worktreeCloseConfirm).toBeNull();
  });
});

describe('splitPane — live CWD', () => {
  it('uses the live CWD from cwd-store for the new pane', () => {
    // Prime cwd-store with a different CWD than what's in the tab
    useCwdStore.setState({ cwds: new Map([['pane-a1', '/live/path']]) });

    const newPaneId = useWorkspaceStore.getState().splitPane('pane-a1', 'horizontal');

    // Find the new leaf's CWD via collectPaneLeafs
    const tab = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === 'tab-a1')!;
    const leaves = collectPaneLeafs(tab.splitRoot);
    const newLeaf = leaves.find((l) => l.id === newPaneId);
    expect(newLeaf?.cwd).toBe('/live/path');
  });

  it('falls back to tab.cwd when no live CWD in cwd-store', () => {
    useCwdStore.setState({ cwds: new Map() });

    const newPaneId = useWorkspaceStore.getState().splitPane('pane-a1', 'horizontal');

    const tab = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === 'tab-a1')!;
    const leaves = collectPaneLeafs(tab.splitRoot);
    const newLeaf = leaves.find((l) => l.id === newPaneId);
    expect(newLeaf?.cwd).toBe('/tmp'); // WS_A's tab cwd
  });
});

describe('duplicateTab — live CWD', () => {
  it('opens a new terminal tab at the active pane live CWD', () => {
    const ws: Workspace = {
      id: 'ws-dup',
      label: 'Duplicate',
      tabs: [
        {
          id: 'tab-dup',
          label: 'Shell',
          labelIsCustom: false,
          cwd: '/stored/tab',
          splitRoot: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            children: [
              { type: 'leaf', id: 'pane-left', cwd: '/stored/left' },
              { type: 'leaf', id: 'pane-right', cwd: '/stored/right' }
            ]
          }
        }
      ]
    };
    useWorkspaceStore.setState({
      workspace: ws,
      activeTabId: 'tab-dup',
      activePaneId: 'pane-right'
    });
    useCwdStore.setState({ cwds: new Map([['pane-right', '/live/right']]) });

    const newPaneId = useWorkspaceStore.getState().duplicateTab('tab-dup');

    const state = useWorkspaceStore.getState();
    const duplicated = state.workspace.tabs.at(-1)!;
    expect(newPaneId).toBe(state.activePaneId);
    expect(duplicated.cwd).toBe('/live/right');
    expect(duplicated.splitRoot).toMatchObject({ type: 'leaf', id: newPaneId, cwd: '/live/right' });
  });

  it('falls back to the active pane stored CWD when no live CWD is available', () => {
    const ws: Workspace = {
      id: 'ws-dup',
      label: 'Duplicate',
      tabs: [
        {
          id: 'tab-dup',
          label: 'Shell',
          labelIsCustom: false,
          cwd: '/stored/tab',
          splitRoot: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            children: [
              { type: 'leaf', id: 'pane-left', cwd: '/stored/left' },
              { type: 'leaf', id: 'pane-right', cwd: '/stored/right' }
            ]
          }
        }
      ]
    };
    useWorkspaceStore.setState({
      workspace: ws,
      activeTabId: 'tab-dup',
      activePaneId: 'pane-right'
    });
    useCwdStore.setState({ cwds: new Map() });

    useWorkspaceStore.getState().duplicateTab('tab-dup');

    const duplicated = useWorkspaceStore.getState().workspace.tabs.at(-1)!;
    expect(duplicated.cwd).toBe('/stored/right');
    expect(duplicated.splitRoot).toMatchObject({ type: 'leaf', cwd: '/stored/right' });
  });

  it('does not duplicate kanban tabs', () => {
    const ws: Workspace = {
      id: 'ws-kanban',
      label: 'Kanban Workspace',
      tabs: [
        {
          id: 'tab-kanban',
          label: 'Kanban',
          labelIsCustom: true,
          cwd: '/project',
          type: 'kanban',
          splitRoot: {
            type: 'leaf',
            id: 'pane-kanban',
            cwd: '/project',
            paneType: 'kanban'
          }
        }
      ]
    };
    useWorkspaceStore.setState({
      workspace: ws,
      activeTabId: 'tab-kanban',
      activePaneId: 'pane-kanban'
    });

    const newPaneId = useWorkspaceStore.getState().duplicateTab('tab-kanban');

    const state = useWorkspaceStore.getState();
    expect(newPaneId).toBeNull();
    expect(state.workspace.tabs).toHaveLength(1);
  });

  it('does not duplicate file tabs', () => {
    const ws: Workspace = {
      id: 'ws-file',
      label: 'File Workspace',
      tabs: [
        {
          id: 'tab-file',
          label: 'notes.md',
          labelIsCustom: true,
          cwd: '/project',
          type: 'file',
          splitRoot: {
            type: 'leaf',
            id: 'pane-file',
            cwd: '/project',
            paneType: 'file',
            filePath: '/project/notes.md'
          }
        }
      ]
    };
    useWorkspaceStore.setState({
      workspace: ws,
      activeTabId: 'tab-file',
      activePaneId: 'pane-file'
    });

    const newPaneId = useWorkspaceStore.getState().duplicateTab('tab-file');

    const state = useWorkspaceStore.getState();
    expect(newPaneId).toBeNull();
    expect(state.workspace.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe('tab-file');
    expect(state.activePaneId).toBe('pane-file');
  });
});

describe('ensureKanbanTab', () => {
  it('pins a single kanban tab at the top when absent', () => {
    useWorkspaceStore.setState({
      workspace: {
        id: 'ws',
        label: 'W',
        tabs: [
          {
            id: 't1',
            label: 'T',
            labelIsCustom: false,
            cwd: '/tmp',
            splitRoot: { type: 'leaf' as const, id: 'p1', cwd: '/tmp' }
          }
        ]
      },
      backgroundWorkspaces: new Map(),
      activeTabId: 't1',
      activePaneId: 'p1',
      isDirty: false,
      lastClosedTab: null,
      recentFiles: []
    });
    useWorkspaceStore.getState().ensureKanbanTab();
    const { tabs } = useWorkspaceStore.getState().workspace;
    expect(tabs.filter((t) => t.type === 'kanban')).toHaveLength(1);
    expect(tabs[0].type).toBe('kanban');
    expect(tabs[0].splitRoot.type).toBe('leaf');
  });

  it('dedupes pre-existing duplicate kanban tabs down to one at the top', () => {
    useWorkspaceStore.setState({
      workspace: {
        id: 'ws',
        label: 'W',
        tabs: [
          {
            id: 't1',
            label: 'T',
            labelIsCustom: false,
            cwd: '/tmp',
            splitRoot: { type: 'leaf' as const, id: 'p1', cwd: '/tmp' }
          },
          {
            id: 'k1',
            label: 'Kanban',
            labelIsCustom: true,
            type: 'kanban' as const,
            cwd: '/',
            splitRoot: { type: 'leaf' as const, id: 'pk1', cwd: '/' }
          },
          {
            id: 'k2',
            label: 'Kanban',
            labelIsCustom: true,
            type: 'kanban' as const,
            cwd: '/',
            splitRoot: { type: 'leaf' as const, id: 'pk2', cwd: '/' }
          }
        ]
      },
      backgroundWorkspaces: new Map(),
      activeTabId: 't1',
      activePaneId: 'p1',
      isDirty: false,
      lastClosedTab: null,
      recentFiles: []
    });
    useWorkspaceStore.getState().ensureKanbanTab();
    const { tabs } = useWorkspaceStore.getState().workspace;
    expect(tabs.filter((t) => t.type === 'kanban')).toHaveLength(1);
    expect(tabs[0].id).toBe('k1');
  });

  it('does not let closeTab close a pinned kanban tab', () => {
    useWorkspaceStore.setState({
      workspace: {
        id: 'ws',
        label: 'W',
        tabs: [
          {
            id: 'k1',
            label: 'Kanban',
            labelIsCustom: true,
            type: 'kanban' as const,
            cwd: '/',
            splitRoot: { type: 'leaf' as const, id: 'pk1', cwd: '/' }
          }
        ]
      },
      backgroundWorkspaces: new Map(),
      activeTabId: 'k1',
      activePaneId: 'pk1',
      isDirty: false,
      lastClosedTab: null,
      recentFiles: []
    });
    useWorkspaceStore.getState().closeTab('k1');
    expect(useWorkspaceStore.getState().workspace.tabs.some((t) => t.id === 'k1')).toBe(true);
  });
});

describe('terminalBeside', () => {
  /** A tab holding one agent pane, the way openAgentPane leaves it. */
  const agentTab = {
    id: 'tab-agent',
    label: 'proj',
    labelIsCustom: true,
    cwd: '/proj',
    type: 'agent' as const,
    splitRoot: { type: 'leaf' as const, id: 'pane-agent', cwd: '/proj', paneType: 'agent' as const }
  };

  beforeEach(() => {
    useWorkspaceStore.setState({
      workspace: { ...WS_A, tabs: [...WS_A.tabs, agentTab] }
    });
  });

  it('splits a terminal below the agent when the tab has none', () => {
    const paneId = useWorkspaceStore.getState().terminalBeside('pane-agent');

    const tab = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === 'tab-agent')!;
    expect(tab.splitRoot.type === 'split' && tab.splitRoot.direction).toBe('vertical');
    expect(collectPaneLeafs(tab.splitRoot).map((l) => l.id)).toContain(paneId);
    // It opens where the agent works, so the command lands in the right folder.
    expect(collectPaneLeafs(tab.splitRoot).find((l) => l.id === paneId)?.cwd).toBe('/proj');
  });

  // Asking twice is a conversation that needed the user twice, not a reason to
  // tile the tab with terminals.
  it('reuses the terminal it opened the first time', () => {
    const first = useWorkspaceStore.getState().terminalBeside('pane-agent');
    const second = useWorkspaceStore.getState().terminalBeside('pane-agent');

    expect(second).toBe(first);
    const tab = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === 'tab-agent')!;
    expect(collectPaneLeafs(tab.splitRoot)).toHaveLength(2);
  });

  it('puts the user in front of the terminal it chose', () => {
    useWorkspaceStore.setState({ activeTabId: 'tab-a1', activePaneId: 'pane-a1' });

    const paneId = useWorkspaceStore.getState().terminalBeside('pane-agent');

    expect(useWorkspaceStore.getState().activeTabId).toBe('tab-agent');
    expect(useWorkspaceStore.getState().activePaneId).toBe(paneId);
  });

  it('has nowhere to put a command from a pane that is gone', () => {
    expect(useWorkspaceStore.getState().terminalBeside('pane-closed')).toBeNull();
  });
});
