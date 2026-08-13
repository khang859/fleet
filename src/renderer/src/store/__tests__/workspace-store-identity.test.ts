import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '../workspace-store';
import type { Workspace, PaneNode } from '../../../../shared/types';

/**
 * Reference-identity guards for the two actions that fire continuously (#541).
 *
 * `setPaneDirty` runs on every editor keystroke and `resizeSplit` on every
 * mousemove of a divider drag. Both used to replace the workspace object, the
 * tabs array and every tab in it unconditionally, which broke App's `useShallow`
 * and re-rendered every pane in every tab - including the hidden ones.
 *
 * These assertions are about object identity, not values: the values were always
 * right. Identity is what decides whether the app re-renders.
 */

const SPLIT_ROOT: PaneNode = {
  type: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  children: [
    { type: 'leaf', id: 'pane-editor', cwd: '/tmp', paneType: 'file' },
    { type: 'leaf', id: 'pane-term', cwd: '/tmp' }
  ]
};

const WORKSPACE: Workspace = {
  id: 'ws-identity',
  label: 'Identity',
  tabs: [
    {
      id: 'tab-1',
      label: 'Editing',
      labelIsCustom: false,
      cwd: '/tmp',
      splitRoot: SPLIT_ROOT
    },
    {
      id: 'tab-2',
      label: 'Other',
      labelIsCustom: false,
      cwd: '/other',
      splitRoot: { type: 'leaf', id: 'pane-other', cwd: '/other' }
    }
  ]
};

beforeEach(() => {
  useWorkspaceStore.setState({
    workspace: structuredClone(WORKSPACE),
    activeTabId: 'tab-1',
    activePaneId: 'pane-editor'
  });
});

describe('setPaneDirty identity', () => {
  it('leaves the workspace untouched when the flag is already the value being set', () => {
    const before = useWorkspaceStore.getState().workspace;

    // Already false on a fresh leaf: the no-op case.
    useWorkspaceStore.getState().setPaneDirty('pane-editor', false);
    expect(useWorkspaceStore.getState().workspace).toBe(before);

    // And the repeat-true case, which is what every keystroke after the first is.
    useWorkspaceStore.getState().setPaneDirty('pane-editor', true);
    const dirtied = useWorkspaceStore.getState().workspace;
    expect(dirtied).not.toBe(before);

    useWorkspaceStore.getState().setPaneDirty('pane-editor', true);
    expect(useWorkspaceStore.getState().workspace).toBe(dirtied);
  });

  it('leaves an unknown pane id untouched', () => {
    const before = useWorkspaceStore.getState().workspace;
    useWorkspaceStore.getState().setPaneDirty('pane-does-not-exist', true);
    expect(useWorkspaceStore.getState().workspace).toBe(before);
  });

  it('replaces only the owning tab and only the spine down to the edited leaf', () => {
    const before = useWorkspaceStore.getState().workspace;
    const beforeTab1 = before.tabs[0];
    const beforeTab2 = before.tabs[1];
    const beforeSibling = (beforeTab1.splitRoot as Extract<PaneNode, { type: 'split' }>)
      .children[1];

    useWorkspaceStore.getState().setPaneDirty('pane-editor', true);
    const after = useWorkspaceStore.getState().workspace;

    // The tab that does not own the pane keeps its identity, so a memoized
    // PaneGrid for it can skip.
    expect(after.tabs[1]).toBe(beforeTab2);
    expect(after.tabs[0]).not.toBe(beforeTab1);

    // Within the owning tab, only the edited leaf is new.
    const afterRoot = after.tabs[0].splitRoot as Extract<PaneNode, { type: 'split' }>;
    expect(afterRoot.children[1]).toBe(beforeSibling);
    expect((afterRoot.children[0] as { isDirty?: boolean }).isDirty).toBe(true);
  });

  it('still clears the flag', () => {
    useWorkspaceStore.getState().setPaneDirty('pane-editor', true);
    useWorkspaceStore.getState().setPaneDirty('pane-editor', false);
    const root = useWorkspaceStore.getState().workspace.tabs[0].splitRoot as Extract<
      PaneNode,
      { type: 'split' }
    >;
    expect((root.children[0] as { isDirty?: boolean }).isDirty).toBe(false);
  });
});

describe('resizeSplit identity', () => {
  it('leaves the workspace untouched when the ratio has not moved', () => {
    const before = useWorkspaceStore.getState().workspace;
    useWorkspaceStore.getState().resizeSplit([], 0.5);
    expect(useWorkspaceStore.getState().workspace).toBe(before);
  });

  it('leaves the workspace untouched when a clamped ratio lands on the current one', () => {
    useWorkspaceStore.getState().resizeSplit([], 0.05); // clamps to 0.15
    const clamped = useWorkspaceStore.getState().workspace;
    expect((clamped.tabs[0].splitRoot as Extract<PaneNode, { type: 'split' }>).ratio).toBe(0.15);

    useWorkspaceStore.getState().resizeSplit([], 0.01); // clamps to 0.15 again
    expect(useWorkspaceStore.getState().workspace).toBe(clamped);
  });

  it('replaces only the active tab when the ratio does move', () => {
    const before = useWorkspaceStore.getState().workspace;
    const beforeTab2 = before.tabs[1];

    useWorkspaceStore.getState().resizeSplit([], 0.7);
    const after = useWorkspaceStore.getState().workspace;

    expect(after.tabs[1]).toBe(beforeTab2);
    expect((after.tabs[0].splitRoot as Extract<PaneNode, { type: 'split' }>).ratio).toBe(0.7);
  });
});
