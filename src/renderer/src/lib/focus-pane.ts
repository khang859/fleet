import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';
import { switchToWorkspace } from './switch-workspace';

/** The workspace running a pane in the background, if it is not the current one. */
function backgroundWorkspaceOf(paneId: string): string | null {
  for (const [wsId, ws] of useWorkspaceStore.getState().backgroundWorkspaces) {
    if (ws.tabs.some((t) => collectPaneIds(t.splitRoot).includes(paneId))) return wsId;
  }
  return null;
}

/**
 * Bring a pane in front of the user: switch to its workspace if it runs in the
 * background, activate its tab and pane, then have it take keyboard focus.
 * Resolves false when no open workspace has the pane.
 */
export async function focusPane(paneId: string): Promise<boolean> {
  const inCurrent = (): boolean =>
    useWorkspaceStore
      .getState()
      .workspace.tabs.some((t) => collectPaneIds(t.splitRoot).includes(paneId));

  if (!inCurrent()) {
    const wsId = backgroundWorkspaceOf(paneId);
    if (!wsId) return false;
    await switchToWorkspace(wsId);
  }

  const state = useWorkspaceStore.getState();
  const tab = state.workspace.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId));
  if (!tab) return false;
  useWorkspaceStore.setState({ activeTabId: tab.id, activePaneId: paneId });
  // Being on the right tab is not being in front of the thing that asked: a
  // terminal still has to take the cursor, and an agent pane parked on its
  // Settings view would show a settings screen to someone who came here to
  // answer a question. The frame lets a just-shown tab mount first.
  requestAnimationFrame(() => {
    document.dispatchEvent(new CustomEvent('fleet:refocus-pane', { detail: { paneId } }));
  });
  return true;
}
