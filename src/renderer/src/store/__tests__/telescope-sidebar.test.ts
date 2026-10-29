import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '../workspace-store';
import { MIN_SIDEBAR_WIDTH } from '../../components/sidebar-constants';

describe('Telescope browser sidebar state', () => {
  beforeEach(() => {
    Object.assign(window, { innerWidth: 1600 });
    useWorkspaceStore.setState({
      workspace: { id: 'ws', label: 'WS', tabs: [] },
      isDirty: false
    });
  });

  it('toggles open and closed, and marks the workspace for saving', () => {
    const { toggleTelescopeSidebar } = useWorkspaceStore.getState();

    toggleTelescopeSidebar();
    expect(useWorkspaceStore.getState().workspace.telescopeSidebarOpen).toBe(true);
    expect(useWorkspaceStore.getState().isDirty).toBe(true);

    toggleTelescopeSidebar();
    expect(useWorkspaceStore.getState().workspace.telescopeSidebarOpen).toBe(false);
  });

  it('clamps the width it saves', () => {
    useWorkspaceStore.getState().setTelescopeSidebarWidth(10);
    expect(useWorkspaceStore.getState().workspace.telescopeSidebarWidth).toBe(MIN_SIDEBAR_WIDTH);
  });

  it('does not mark the workspace dirty when the width is unchanged', () => {
    useWorkspaceStore.getState().setTelescopeSidebarWidth(300);
    useWorkspaceStore.setState({ isDirty: false });

    useWorkspaceStore.getState().setTelescopeSidebarWidth(300);
    expect(useWorkspaceStore.getState().isDirty).toBe(false);
  });
});
