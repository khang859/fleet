import { useEffect } from 'react';
import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';
import { useVisualizerStore } from '../store/visualizer-store';
import { ALL_SHORTCUTS, matchesShortcut, type ShortcutDef } from '../lib/shortcuts';

function sc(id: string): ShortcutDef {
  return ALL_SHORTCUTS.find((s) => s.id === id)!;
}

export function usePaneNavigation(): void {
  const { workspace, activeTabId, activePaneId, addTab, closePane, splitPane, setActiveTab } =
    useWorkspaceStore();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      // F2 to rename active tab
      if (matchesShortcut(e, sc('rename-tab'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:rename-active-tab'));
        return;
      }

      if (matchesShortcut(e, sc('new-tab'))) {
        e.preventDefault();
        addTab(undefined, window.fleet.homeDir);
        return;
      }

      if (matchesShortcut(e, sc('close-pane'))) {
        e.preventDefault();
        if (activePaneId) closePane(activePaneId);
        return;
      }

      // Split down must be checked before split right (superset modifiers)
      if (matchesShortcut(e, sc('split-down'))) {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'vertical');
        return;
      }

      if (matchesShortcut(e, sc('split-right'))) {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'horizontal');
        return;
      }

      // Navigate panes
      if (matchesShortcut(e, sc('navigate-prev')) || matchesShortcut(e, sc('navigate-next'))) {
        e.preventDefault();
        const state = useWorkspaceStore.getState();
        const activeTab = state.workspace.tabs.find((t) => t.id === state.activeTabId);
        if (!activeTab) return;
        const tabPaneIds = collectPaneIds(activeTab.splitRoot);
        const currentIndex = activePaneId ? tabPaneIds.indexOf(activePaneId) : -1;
        const forward = matchesShortcut(e, sc('navigate-next'));
        const nextIndex = forward
          ? (currentIndex + 1) % tabPaneIds.length
          : (currentIndex - 1 + tabPaneIds.length) % tabPaneIds.length;
        if (tabPaneIds[nextIndex]) {
          state.setActivePane(tabPaneIds[nextIndex]);
        }
        return;
      }

      // Cycle tabs
      if (matchesShortcut(e, sc('cycle-tab-next')) || matchesShortcut(e, sc('cycle-tab-prev'))) {
        e.preventDefault();
        const tabIndex = workspace.tabs.findIndex((t) => t.id === activeTabId);
        const forward = matchesShortcut(e, sc('cycle-tab-next'));
        const nextIndex = forward
          ? (tabIndex + 1) % workspace.tabs.length
          : (tabIndex - 1 + workspace.tabs.length) % workspace.tabs.length;
        if (workspace.tabs[nextIndex]) setActiveTab(workspace.tabs[nextIndex].id);
        return;
      }

      if (matchesShortcut(e, sc('search'))) {
        e.preventDefault();
        document.dispatchEvent(
          new CustomEvent('fleet:toggle-search', { detail: { paneId: activePaneId } })
        );
        return;
      }

      if (matchesShortcut(e, sc('visualizer'))) {
        e.preventDefault();
        useVisualizerStore.getState().toggleVisible();
        return;
      }

      if (matchesShortcut(e, sc('settings'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-settings'));
        return;
      }

      if (matchesShortcut(e, sc('shortcuts'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-shortcuts'));
        return;
      }

      if (matchesShortcut(e, sc('command-palette'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-command-palette'));
        return;
      }

      if (matchesShortcut(e, sc('git-changes'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes'));
        return;
      }

      if (matchesShortcut(e, sc('open-file'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:open-file-dialog'));
        return;
      }

      if (matchesShortcut(e, sc('quick-open'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-quick-open'));
        return;
      }

      if (matchesShortcut(e, sc('file-browser'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-file-browser'));
        return;
      }

      // Cmd/Ctrl+1-9 to switch tabs (check metaKey on mac, ctrlKey on other)
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      const modHeld = isMac ? e.metaKey : e.ctrlKey;
      if (modHeld && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key) - 1;
        const tab = workspace.tabs[index];
        if (tab) setActiveTab(tab.id);
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspace, activeTabId, activePaneId, addTab, closePane, splitPane, setActiveTab]);
}
