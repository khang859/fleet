import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '../workspace-store';
import { useCwdStore } from '../cwd-store';

/**
 * Tests that Zustand subscriptions use granular selectors to prevent
 * unnecessary re-renders (audit issue: "Broad Zustand Subscriptions").
 *
 * The core problem: calling useWorkspaceStore() without a selector or with
 * a broad destructure causes components to re-render on ANY store change.
 * useShallow ensures shallow equality checks on the returned object.
 */

describe('workspace store selector stability', () => {
  beforeEach(() => {
    // Reset store to a known state
    const store = useWorkspaceStore;
    store.setState({
      workspace: {
        id: 'default',
        label: 'Default',
        tabs: [
          {
            id: 'tab-1',
            label: 'Shell',
            labelIsCustom: false,
            cwd: '/tmp',
            splitRoot: { type: 'leaf', id: 'pane-1', cwd: '/tmp' }
          }
        ]
      },
      activeTabId: 'tab-1',
      activePaneId: 'pane-1',
      isDirty: false,
      lastClosedTab: null
    });
  });

  it('selecting workspace returns same reference when unrelated state changes', () => {
    const selector = (s: ReturnType<typeof useWorkspaceStore.getState>): unknown => s.workspace;
    const before = selector(useWorkspaceStore.getState());

    // Toggling isDirty should NOT create a new workspace reference
    useWorkspaceStore.setState({ isDirty: true });
    const after = selector(useWorkspaceStore.getState());

    expect(after).toBe(before);
  });

  it('selecting activeTabId returns same value when workspace label changes', () => {
    const selector = (s: ReturnType<typeof useWorkspaceStore.getState>): unknown => s.activeTabId;
    const before = selector(useWorkspaceStore.getState());

    useWorkspaceStore.getState().renameWorkspace('New Name');
    const after = selector(useWorkspaceStore.getState());

    expect(after).toBe(before);
  });
});

describe('cwd store selector stability', () => {
  beforeEach(() => {
    useCwdStore.setState({ cwds: new Map() });
  });

  it('granular pane selector is unaffected by other pane CWD changes', () => {
    const { setCwd } = useCwdStore.getState();
    setCwd('pane-active', '/home/user');

    // Selector for just the active pane's CWD
    const selector = (s: ReturnType<typeof useCwdStore.getState>): string | undefined =>
      s.cwds.get('pane-active');

    const before = selector(useCwdStore.getState());

    // Another pane's CWD changes — should NOT affect our selected value
    setCwd('pane-other', '/var/log');
    const after = selector(useCwdStore.getState());

    expect(after).toBe(before);
    expect(after).toBe('/home/user');
  });

  it('granular pane selector updates when the specific pane CWD changes', () => {
    const { setCwd } = useCwdStore.getState();
    setCwd('pane-active', '/home/user');

    const selector = (s: ReturnType<typeof useCwdStore.getState>): string | undefined =>
      s.cwds.get('pane-active');

    const before = selector(useCwdStore.getState());
    setCwd('pane-active', '/home/user/projects');
    const after = selector(useCwdStore.getState());

    expect(before).toBe('/home/user');
    expect(after).toBe('/home/user/projects');
    expect(after).not.toBe(before);
  });

  it('broad cwds subscription gets new reference on ANY pane CWD change', () => {
    const { setCwd } = useCwdStore.getState();
    setCwd('pane-1', '/tmp');

    // This is the BAD pattern — subscribing to the whole cwds Map
    const broadSelector = (s: ReturnType<typeof useCwdStore.getState>): Map<string, string> =>
      s.cwds;

    const before = broadSelector(useCwdStore.getState());
    setCwd('pane-other', '/var');
    const after = broadSelector(useCwdStore.getState());

    // The Map reference changes even though pane-1's CWD didn't change
    // This is why broad subscriptions cause unnecessary re-renders
    expect(after).not.toBe(before);
  });
});
