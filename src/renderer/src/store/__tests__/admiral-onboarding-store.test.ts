import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../../../shared/types';

/**
 * The header switcher's move, against the real workspace store: a project
 * with an Admiral tab open is brought forward, in whichever workspace it is,
 * and only a project without one opens a new Admiral.
 */

const openAdmiral = vi.fn(async () => Promise.resolve('opened' as const));
vi.mock('../../lib/open-admiral', () => ({ openAdmiral }));

const { useWorkspaceStore } = await import('../workspace-store');
const { switchToProject, useAdmiralOnboardingStore } = await import('../admiral-onboarding-store');

const REPO = { repoId: '0123456789abcdef', root: '/dev/fleet', name: 'fleet' };
const OTHER = { repoId: 'fedcba9876543210', root: '/dev/eva', name: 'eva' };

const SHELL: Workspace = {
  id: 'ws-shell',
  label: 'Shell',
  tabs: [
    {
      id: 'tab-shell',
      label: 'Shell',
      labelIsCustom: false,
      cwd: '/tmp',
      splitRoot: { type: 'leaf', id: 'pane-shell', cwd: '/tmp' }
    }
  ]
};

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  window.fleet.homeDir = '/home/k';
  useWorkspaceStore.setState({
    workspace: structuredClone(SHELL),
    backgroundWorkspaces: new Map(),
    activeTabId: 'tab-shell',
    activePaneId: 'pane-shell'
  });
  useWorkspaceStore
    .getState()
    .openAdmiralPane(REPO, { paneId: 'pane-admiral', lobbySessionId: 'lobby-1' });
  // The client went back to their terminal.
  useWorkspaceStore.setState({ activeTabId: 'tab-shell', activePaneId: 'pane-shell' });
});

afterEach(() => vi.unstubAllGlobals());

describe('switchToProject', () => {
  it('focuses the Admiral tab already open for the project instead of opening another', async () => {
    expect(await switchToProject(REPO)).toBe('focused');
    const state = useWorkspaceStore.getState();
    expect(state.activePaneId).toBe('pane-admiral');
    expect(state.workspace.tabs.find((t) => t.id === state.activeTabId)?.label).toBe(
      'Admiral · fleet'
    );
    expect(state.workspace.tabs).toHaveLength(2);
    expect(openAdmiral).not.toHaveBeenCalled();
  });

  it('opens an Admiral for a project that has none open', async () => {
    expect(await switchToProject(OTHER)).toBe('opened');
    expect(openAdmiral).toHaveBeenCalledWith('/dev/eva');
    expect(useWorkspaceStore.getState().activePaneId).toBe('pane-shell');
  });
});

describe('picking', () => {
  it('turns a pane to the picker and back, one pane at a time', () => {
    const { setPicking } = useAdmiralOnboardingStore.getState();
    setPicking('pane-a', true);
    setPicking('pane-b', true);
    setPicking('pane-a', false);
    expect(useAdmiralOnboardingStore.getState().picking).toEqual({ 'pane-b': true });
  });
});
