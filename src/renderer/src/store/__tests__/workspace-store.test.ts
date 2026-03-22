import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '../workspace-store';
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
