import { describe, it, expect, beforeEach } from 'vitest';
import {
  useWorkspaceStore,
  collectPaneLeafs,
  collectPaneIds,
  agentSessionsInUse,
  registerPaneDisposer
} from '../workspace-store';
import { useCwdStore } from '../cwd-store';
import { scratchDir, isScratchTab } from '../../lib/scratch';
import type { Workspace } from '../../../../shared/types';

const ANNOTATE_TAB_A = {
  id: 'tab-ann-a',
  label: 'Annotate',
  labelIsCustom: true,
  cwd: '/tmp',
  type: 'annotate' as const,
  splitRoot: { type: 'leaf' as const, id: 'pane-ann-a', cwd: '/tmp' }
};

const ANNOTATE_TAB_B = {
  id: 'tab-ann-b',
  label: 'Annotate',
  labelIsCustom: true,
  cwd: '/home',
  type: 'annotate' as const,
  splitRoot: { type: 'leaf' as const, id: 'pane-ann-b', cwd: '/home' }
};

const ANNOTATE_TAB_C = {
  id: 'tab-ann-c',
  label: 'Annotate',
  labelIsCustom: true,
  cwd: '/',
  type: 'annotate' as const,
  splitRoot: { type: 'leaf' as const, id: 'pane-ann-c', cwd: '/' }
};

const WS_A: Workspace = {
  id: 'ws-a',
  label: 'Alpha',
  tabs: [
    ANNOTATE_TAB_A,
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
    ANNOTATE_TAB_B,
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
    ANNOTATE_TAB_C,
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
    set: async () => Promise.resolve(undefined),
    get: async () => Promise.resolve({})
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

  it('does not create a scratch conversation when opening an empty workspace', () => {
    useWorkspaceStore.getState().switchWorkspace({ id: 'ws-empty', label: 'Empty', tabs: [] });
    expect(useWorkspaceStore.getState().workspace.tabs.map((t) => t.type)).toEqual(['annotate']);
  });

  describe('scratch chat creation', () => {
    function openScratch(): { id: string; paneId: string } {
      useWorkspaceStore.getState().openScratch();
      const state = useWorkspaceStore.getState();
      const tab = state.workspace.tabs.find((t) => t.id === state.activeTabId);
      if (!tab || !isScratchTab(tab)) throw new Error('no active scratch chat');
      return { id: tab.id, paneId: collectPaneIds(tab.splitRoot)[0] };
    }

    it('opens and focuses a separate chat on every click without replacing the previous one', () => {
      const first = openScratch();
      const firstTab = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === first.id)!;
      const firstSession = collectPaneLeafs(firstTab.splitRoot)[0].agentSessionId;
      const second = openScratch();
      const state = useWorkspaceStore.getState();
      const secondTab = state.workspace.tabs.find((t) => t.id === second.id)!;
      expect(second.id).not.toBe(first.id);
      expect(second.paneId).not.toBe(first.paneId);
      expect(collectPaneLeafs(secondTab.splitRoot)[0].agentSessionId).not.toBe(firstSession);
      expect(state.workspace.tabs.find((t) => t.id === first.id)).toEqual(firstTab);
      expect(state.workspace.tabs.filter(isScratchTab)).toHaveLength(2);
      expect(state.activeTabId).toBe(second.id);
      expect(state.activePaneId).toBe(second.paneId);
      expect(secondTab.label).toBe('Scratch chat');
    });

    it('preserves existing chats during tool reconciliation and ignores the legacy toggle', () => {
      const first = openScratch();
      useWorkspaceStore.getState().reconcileToolTabs();
      useWorkspaceStore.getState().setToolVisible('scratch', false);
      expect(
        useWorkspaceStore
          .getState()
          .workspace.tabs.filter(isScratchTab)
          .map((t) => t.id)
      ).toEqual([first.id]);
      openScratch();
      expect(useWorkspaceStore.getState().workspace.tabs.filter(isScratchTab)).toHaveLength(2);
    });

    it('keeps a legacy shared-folder conversation on workspace restore', () => {
      const first = openScratch();
      const saved = useWorkspaceStore.getState().workspace;
      useWorkspaceStore.getState().switchWorkspace({ id: 'other', label: 'Other', tabs: [] });
      useWorkspaceStore.getState().switchWorkspace(saved);
      expect(
        useWorkspaceStore
          .getState()
          .workspace.tabs.filter(isScratchTab)
          .map((t) => t.id)
      ).toEqual([first.id]);
    });

    it('renames a legacy pinned Scratch tab to match new chats, but leaves custom titles', () => {
      const ws: Workspace = {
        id: 'ws-legacy',
        label: 'Legacy',
        tabs: [
          {
            id: 'tab-legacy',
            label: 'Scratch',
            labelIsCustom: true,
            cwd: scratchDir(),
            type: 'agent',
            splitRoot: { type: 'leaf', id: 'pane-legacy', cwd: scratchDir() }
          },
          {
            id: 'tab-titled',
            label: 'Trip notes',
            labelIsCustom: true,
            cwd: `${scratchDir()}/abc`,
            type: 'agent',
            splitRoot: { type: 'leaf', id: 'pane-titled', cwd: `${scratchDir()}/abc` }
          },
          {
            id: 'tab-project',
            label: 'Scratch',
            labelIsCustom: true,
            cwd: '/repo',
            type: 'agent',
            splitRoot: { type: 'leaf', id: 'pane-project', cwd: '/repo' }
          }
        ]
      };
      useWorkspaceStore.getState().loadWorkspace(ws);
      const labels = new Map(
        useWorkspaceStore.getState().workspace.tabs.map((t) => [t.id, t.label])
      );
      expect(labels.get('tab-legacy')).toBe('Scratch chat');
      expect(labels.get('tab-titled')).toBe('Trip notes');
      // A project folder someone happened to call Scratch is not a scratch chat.
      expect(labels.get('tab-project')).toBe('Scratch');
    });

    it('closes and disposes one scratch chat without closing another', () => {
      const first = openScratch();
      const second = openScratch();
      const disposed: string[] = [];
      registerPaneDisposer((paneId) => disposed.push(paneId));
      useWorkspaceStore.getState().closeTab(second.id);
      expect(
        useWorkspaceStore
          .getState()
          .workspace.tabs.filter(isScratchTab)
          .map((t) => t.id)
      ).toEqual([first.id]);
      expect(disposed).toEqual([second.paneId]);
      registerPaneDisposer(() => {});
    });

    it('allows closing the scratch pane', () => {
      const { id, paneId } = openScratch();
      useWorkspaceStore.getState().closePane(paneId);
      expect(useWorkspaceStore.getState().workspace.tabs.some((t) => t.id === id)).toBe(false);
    });

    it('reopens the same scratch session with undo close tab', () => {
      const { id } = openScratch();
      const before = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === id)!;
      useWorkspaceStore.getState().closeTab(id);
      expect(useWorkspaceStore.getState().workspace.tabs.some((t) => t.id === id)).toBe(false);
      useWorkspaceStore.getState().undoCloseTab();
      const restored = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === id)!;
      expect(collectPaneLeafs(restored.splitRoot)[0].agentSessionId).toBe(
        collectPaneLeafs(before.splitRoot)[0].agentSessionId
      );
    });

    it('lets a terminal opened beside the conversation be closed again', () => {
      const { id, paneId } = openScratch();
      const terminalId = useWorkspaceStore.getState().terminalBeside(paneId);
      expect(terminalId).not.toBeNull();
      if (terminalId === null) return;
      useWorkspaceStore.getState().closePane(terminalId);
      const tab = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === id);
      expect(tab && collectPaneIds(tab.splitRoot)).toEqual([paneId]);
    });
  });

  it('strips a disabled tool tab and recreates it when re-enabled', () => {
    const emptyWs: Workspace = { id: 'ws-vis', label: 'Visibility', tabs: [] };
    useWorkspaceStore.getState().switchWorkspace(emptyWs);
    // Enabling sessions adds its pinned tab...
    useWorkspaceStore.getState().setToolVisible('sessions', true);
    expect(useWorkspaceStore.getState().workspace.tabs.some((t) => t.type === 'sessions')).toBe(
      true
    );
    // ...and disabling it strips the tab again.
    useWorkspaceStore.getState().setToolVisible('sessions', false);
    expect(useWorkspaceStore.getState().workspace.tabs.some((t) => t.type === 'sessions')).toBe(
      false
    );
  });

  it('strips pinned tabs for removed tools from a persisted workspace', () => {
    // Neither type is in the Tab union any more, so a saved workspace is the
    // only place they can still appear - cast to build one.
    const legacy = {
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
        },
        {
          id: 'tab-kanban',
          label: 'Kanban',
          labelIsCustom: true,
          cwd: '/home',
          type: 'kanban',
          splitRoot: { type: 'leaf', id: 'leaf-kanban', cwd: '/home', paneType: 'kanban' }
        }
      ]
    } as unknown as Workspace;
    useWorkspaceStore.getState().switchWorkspace(legacy);
    const state = useWorkspaceStore.getState();
    expect(state.workspace.tabs.some((t) => t.type === 'artifacts')).toBe(false);
    expect(state.workspace.tabs.some((t) => t.id === 'tab-kanban')).toBe(false);
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
    expect(ids).toContain('pane-ann-a');
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

  it('does not duplicate pinned tool tabs', () => {
    const ws: Workspace = {
      id: 'ws-sessions',
      label: 'Sessions Workspace',
      tabs: [
        {
          id: 'tab-sessions',
          label: 'Sessions',
          labelIsCustom: true,
          cwd: '/project',
          type: 'sessions',
          splitRoot: {
            type: 'leaf',
            id: 'pane-sessions',
            cwd: '/project'
          }
        }
      ]
    };
    useWorkspaceStore.setState({
      workspace: ws,
      activeTabId: 'tab-sessions',
      activePaneId: 'pane-sessions'
    });

    const newPaneId = useWorkspaceStore.getState().duplicateTab('tab-sessions');

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

describe('openAgentPane — worktree', () => {
  const WORKTREE = {
    path: '/home/k/.fleet/worktrees/proj/proj-bold-mast-cove',
    branchName: 'proj-bold-mast-cove',
    repoPath: '/home/k/dev/proj'
  };

  beforeEach(() => {
    useWorkspaceStore.setState({ recentFolders: [] });
  });

  it('marks the tab as owning the worktree so close-time teardown finds it', () => {
    const paneId = useWorkspaceStore.getState().openAgentPane(WORKTREE.path, WORKTREE);

    const tab = useWorkspaceStore
      .getState()
      .workspace.tabs.find((t) => collectPaneLeafs(t.splitRoot).some((l) => l.id === paneId))!;
    expect(tab.worktreePath).toBe(WORKTREE.path);
    expect(tab.worktreeBranch).toBe(WORKTREE.branchName);
    // The branch names the tab: every worktree of a repo shares its folder name.
    expect(tab.label).toBe(WORKTREE.branchName);
    // Standalone by design - the dialog can be pointed at a repo with no tab.
    expect(tab.groupId).toBeUndefined();
  });

  it('records the repository as recent, not the worktree that gets destroyed', () => {
    useWorkspaceStore.getState().openAgentPane(WORKTREE.path, WORKTREE);

    expect(useWorkspaceStore.getState().recentFolders[0]).toBe(WORKTREE.repoPath);
  });

  // The agent can be rooted below the worktree when a subfolder was picked; the
  // tab still has to carry the worktree's own root for `git worktree remove`.
  it('keeps the pane cwd separate from the worktree root', () => {
    const nested = `${WORKTREE.path}/src`;
    const paneId = useWorkspaceStore.getState().openAgentPane(nested, WORKTREE);

    const tab = useWorkspaceStore
      .getState()
      .workspace.tabs.find((t) => collectPaneLeafs(t.splitRoot).some((l) => l.id === paneId))!;
    expect(collectPaneLeafs(tab.splitRoot)[0].cwd).toBe(nested);
    expect(tab.worktreePath).toBe(WORKTREE.path);
  });

  it('routes its close through the worktree confirmation', () => {
    const paneId = useWorkspaceStore.getState().openAgentPane(WORKTREE.path, WORKTREE);
    useWorkspaceStore.setState({ worktreeCloseConfirm: null });

    useWorkspaceStore.getState().closePane(paneId);

    expect(useWorkspaceStore.getState().worktreeCloseConfirm).toEqual({
      tabId: expect.any(String),
      label: WORKTREE.branchName
    });
  });

  it('leaves an ordinary agent pane untouched', () => {
    const paneId = useWorkspaceStore.getState().openAgentPane('/home/k/dev/proj');

    const tab = useWorkspaceStore
      .getState()
      .workspace.tabs.find((t) => collectPaneLeafs(t.splitRoot).some((l) => l.id === paneId))!;
    expect(tab.worktreePath).toBeUndefined();
    expect(tab.worktreeBranch).toBeUndefined();
    expect(tab.label).toBe('proj');
    expect(useWorkspaceStore.getState().recentFolders[0]).toBe('/home/k/dev/proj');
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

// A pane the user `cd`'d out of used to come back in its original folder on
// every restart, because only the live cwd store knew it had moved.
describe('updatePaneCwd', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().loadWorkspace(WS_A);
  });

  it('records the new folder on the pane and its tab', () => {
    useWorkspaceStore.getState().updatePaneCwd('pane-a1', '/var/log');

    const tab = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === 'tab-a1')!;
    expect(collectPaneLeafs(tab.splitRoot)[0]?.cwd).toBe('/var/log');
    expect(tab.cwd).toBe('/var/log');
    expect(useWorkspaceStore.getState().isDirty).toBe(true);
  });

  it('leaves the layout alone when the folder has not moved', () => {
    const before = useWorkspaceStore.getState().workspace;
    useWorkspaceStore.setState({ isDirty: false });

    useWorkspaceStore.getState().updatePaneCwd('pane-a1', '/tmp');

    expect(useWorkspaceStore.getState().workspace).toBe(before);
    expect(useWorkspaceStore.getState().isDirty).toBe(false);
  });

  it('does not let a second split rewrite the tab folder', () => {
    const splitPaneId = useWorkspaceStore.getState().splitPane('pane-a1', 'vertical');

    useWorkspaceStore.getState().updatePaneCwd(splitPaneId, '/var/log');

    const tab = useWorkspaceStore.getState().workspace.tabs.find((t) => t.id === 'tab-a1')!;
    expect(collectPaneLeafs(tab.splitRoot).find((l) => l.id === splitPaneId)?.cwd).toBe('/var/log');
    expect(tab.cwd).toBe('/tmp');
  });
});

// Issue #549: a file opened from a session belongs to it, and the sidebar draws
// it indented underneath - which only works if the list order agrees.
describe('openFile — nesting under a session', () => {
  const NESTED_WS: Workspace = {
    id: 'ws-nest',
    label: 'Nest',
    tabs: [
      {
        id: 'tab-s1',
        label: 'proj',
        labelIsCustom: false,
        cwd: '/repo/proj',
        splitRoot: { type: 'leaf', id: 'pane-s1', cwd: '/repo/proj' }
      },
      {
        id: 'tab-s2',
        label: 'other',
        labelIsCustom: false,
        cwd: '/repo/other',
        splitRoot: { type: 'leaf', id: 'pane-s2', cwd: '/repo/other' }
      }
    ]
  };

  beforeEach(() => {
    useWorkspaceStore.setState({
      workspace: NESTED_WS,
      activeTabId: 'tab-s1',
      activePaneId: 'pane-s1'
    });
  });

  it('parents the file on the active session and inserts it right below', () => {
    useWorkspaceStore.getState().openFile('/repo/proj/a.ts');

    const tabs = useWorkspaceStore.getState().workspace.tabs;
    const file = tabs[1];
    expect(file.parentTabId).toBe('tab-s1');
    expect(tabs.map((t) => t.id)).toEqual(['tab-s1', file.id, 'tab-s2']);
  });

  it('puts the newest file at the top of the nest', () => {
    useWorkspaceStore.getState().openFile('/repo/proj/a.ts');
    const firstId = useWorkspaceStore.getState().workspace.tabs[1].id;
    useWorkspaceStore.getState().openFile('/repo/proj/b.ts');

    const tabs = useWorkspaceStore.getState().workspace.tabs;
    expect(tabs[1].label).toBe('b.ts');
    expect(tabs[2].id).toBe(firstId);
    // Opened from a file tab, so the session had to be found through it.
    expect(tabs[1].parentTabId).toBe('tab-s1');
  });

  it('falls back to the session whose folder holds the file', () => {
    useWorkspaceStore.setState({ activeTabId: null, activePaneId: null });

    useWorkspaceStore.getState().openFile('/repo/other/a.ts');

    const tabs = useWorkspaceStore.getState().workspace.tabs;
    expect(tabs.map((t) => t.id)).toEqual(['tab-s1', 'tab-s2', tabs[2].id]);
    expect(tabs[2].parentTabId).toBe('tab-s2');
  });

  it('prefers the live folder over the stale one', () => {
    useWorkspaceStore.setState({ activeTabId: null, activePaneId: null });
    useCwdStore.setState({ cwds: new Map([['pane-s2', '/elsewhere/deep']]) });

    useWorkspaceStore.getState().openFile('/elsewhere/deep/a.ts');

    const tabs = useWorkspaceStore.getState().workspace.tabs;
    expect(tabs[2].parentTabId).toBe('tab-s2');
    useCwdStore.setState({ cwds: new Map() });
  });

  it('leaves a file that belongs to no session at the end', () => {
    useWorkspaceStore.setState({ activeTabId: null, activePaneId: null });

    useWorkspaceStore.getState().openFile('/nowhere/a.ts');

    const tabs = useWorkspaceStore.getState().workspace.tabs;
    expect(tabs).toHaveLength(3);
    expect(tabs[2].parentTabId).toBeUndefined();
  });

  it('promotes the files when their session closes', () => {
    useWorkspaceStore.getState().openFile('/repo/proj/a.ts');
    useWorkspaceStore.getState().closeTab('tab-s1');

    const tabs = useWorkspaceStore.getState().workspace.tabs;
    // The file survives in place; the sidebar reads a missing parent as "top level".
    expect(tabs.map((t) => t.label)).toEqual(['a.ts', 'other']);
  });
});

describe('reorderTab — nested files', () => {
  function nestedWorkspace(): Workspace {
    return {
      id: 'ws-reorder',
      label: 'Reorder',
      tabs: [
        {
          id: 'tab-s1',
          label: 'proj',
          labelIsCustom: false,
          cwd: '/repo/proj',
          splitRoot: { type: 'leaf', id: 'pane-s1', cwd: '/repo/proj' }
        },
        {
          id: 'tab-f1',
          label: 'a.ts',
          labelIsCustom: true,
          cwd: '/',
          type: 'file',
          parentTabId: 'tab-s1',
          splitRoot: {
            type: 'leaf',
            id: 'pane-f1',
            cwd: '/',
            paneType: 'file',
            filePath: '/repo/proj/a.ts'
          }
        },
        {
          id: 'tab-s2',
          label: 'other',
          labelIsCustom: false,
          cwd: '/repo/other',
          splitRoot: { type: 'leaf', id: 'pane-s2', cwd: '/repo/other' }
        }
      ]
    };
  }

  beforeEach(() => {
    useWorkspaceStore.setState({
      workspace: nestedWorkspace(),
      activeTabId: 'tab-s1',
      activePaneId: 'pane-s1'
    });
  });

  it('carries the nest along when the session moves', () => {
    // Sidebar hands over the index the tab lands on once it has left the list.
    useWorkspaceStore.getState().reorderTab(0, 2);

    const tabs = useWorkspaceStore.getState().workspace.tabs;
    expect(tabs.map((t) => t.id)).toEqual(['tab-s2', 'tab-s1', 'tab-f1']);
    expect(tabs[2].parentTabId).toBe('tab-s1');
  });

  it('never drops a session between another session and its files', () => {
    // tab-s2 aimed at the gap between tab-s1 and its file: it lands after the nest.
    useWorkspaceStore.getState().reorderTab(2, 1);

    const tabs = useWorkspaceStore.getState().workspace.tabs;
    expect(tabs.map((t) => t.id)).toEqual(['tab-s1', 'tab-f1', 'tab-s2']);
  });

  it('detaches a file dragged out of its nest', () => {
    useWorkspaceStore.getState().reorderTab(1, 2);

    const tabs = useWorkspaceStore.getState().workspace.tabs;
    expect(tabs.map((t) => t.id)).toEqual(['tab-s1', 'tab-s2', 'tab-f1']);
    expect(tabs[2].parentTabId).toBeUndefined();
  });
});

/**
 * Which folders count as somewhere the user recently worked.
 *
 * The list is short and it is the first thing the new-agent dialog offers, so
 * anything in it that the user did not choose costs a slot one of their own
 * folders would have had.
 */
describe('addRecentFolder', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ recentFolders: [] });
  });

  it('remembers a folder the user opened', () => {
    useWorkspaceStore.getState().addRecentFolder('/repo/api');
    expect(useWorkspaceStore.getState().recentFolders).toEqual(['/repo/api']);
  });

  it('moves a folder opened again back to the front', () => {
    useWorkspaceStore.getState().addRecentFolder('/repo/api');
    useWorkspaceStore.getState().addRecentFolder('/repo/web');
    useWorkspaceStore.getState().addRecentFolder('/repo/api');

    expect(useWorkspaceStore.getState().recentFolders).toEqual(['/repo/api', '/repo/web']);
  });

  /*
   * The scratch folder is Fleet's own. It is opened on every launch whether or
   * not anybody asked for it, and it is already a pinned tab - so listing it as
   * recent is untrue, and it displaces a folder the user actually chose.
   */
  it('never records the scratch folder', () => {
    useWorkspaceStore.getState().addRecentFolder(scratchDir());
    expect(useWorkspaceStore.getState().recentFolders).toEqual([]);
  });

  it('still records a folder that merely sits near it', () => {
    useWorkspaceStore.getState().addRecentFolder(`${scratchDir()}-notes`);
    expect(useWorkspaceStore.getState().recentFolders).toEqual([`${scratchDir()}-notes`]);
  });
});
