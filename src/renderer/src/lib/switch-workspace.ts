import { useWorkspaceStore, isPinnedTab } from '../store/workspace-store';
import { injectLiveCwd, getFirstPaneLiveCwd } from './workspace-utils';

/**
 * Save the current workspace with its panes' live folders, then make another
 * one current: from memory when it is running in the background, else from disk.
 *
 * The one path for every workspace switch, so the sidebar, the title-bar
 * switcher and anything that jumps to a pane in another workspace save the
 * same thing and seed the same first terminal.
 */
export async function switchToWorkspace(wsId: string): Promise<void> {
  // Flush current workspace with live CWDs BEFORE any async gap
  const state = useWorkspaceStore.getState();
  await window.fleet.layout.save({
    workspace: {
      ...state.workspace,
      activeTabId: state.activeTabId ?? undefined,
      activePaneId: state.activePaneId ?? undefined,
      collapsedGroups: Array.from(state.collapsedGroups),
      tabs: state.workspace.tabs
        .filter((tab) => tab.type !== 'settings')
        .map((tab) => {
          const liveCwd = getFirstPaneLiveCwd(tab.splitRoot);
          return {
            ...tab,
            cwd: liveCwd ?? tab.cwd,
            splitRoot: injectLiveCwd(tab.splitRoot)
          };
        })
    }
  });

  const freshState = useWorkspaceStore.getState();
  const inMemory = freshState.backgroundWorkspaces.get(wsId);
  if (inMemory) {
    freshState.switchWorkspace(inMemory);
  } else {
    const loaded = await window.fleet.layout.load(wsId);
    if (loaded) useWorkspaceStore.getState().switchWorkspace(loaded);
  }

  // Give the workspace its first terminal when it has nothing of its own.
  // The check is for unpinned tabs, not for an empty list: a workspace saved
  // with no tabs - which is what creating one from Settings writes - has
  // already been seeded with the pinned tool tabs by `switchWorkspace` by the
  // time this runs, so a length check would leave it with no terminal.
  setTimeout(() => {
    const s = useWorkspaceStore.getState();
    if (!s.workspace.tabs.some((tab) => !isPinnedTab(tab))) {
      s.addTab(undefined, window.fleet.homeDir);
    }
  }, 0);
}
