import { useEffect } from 'react';
import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';
import { useVisualizerStore } from '../store/visualizer-store';

export function usePaneNavigation() {
  const { workspace, activeTabId, activePaneId, addTab, closePane, splitPane, setActiveTab } =
    useWorkspaceStore();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // F2 to rename active tab (no modifier needed)
      if (e.key === 'F2') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:rename-active-tab'));
        return;
      }

      if (!e.ctrlKey) return;

      if (e.key === 't') {
        e.preventDefault();
        addTab(undefined, window.fleet.homeDir);
      }

      if (e.key === 'w') {
        e.preventDefault();
        if (activePaneId) closePane(activePaneId);
      }

      // Ctrl+Shift+D for vertical split (check before Ctrl+D)
      if (e.shiftKey && e.key === 'D') {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'vertical');
      } else if (e.key === 'd') {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'horizontal');
      }

      // Ctrl+[ / Ctrl+] to navigate panes within current tab only
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const state = useWorkspaceStore.getState();
        const activeTab = state.workspace.tabs.find(t => t.id === state.activeTabId);
        if (!activeTab) return;
        const tabPaneIds = collectPaneIds(activeTab.splitRoot);
        const currentIndex = activePaneId ? tabPaneIds.indexOf(activePaneId) : -1;
        const nextIndex = e.key === ']'
          ? (currentIndex + 1) % tabPaneIds.length
          : (currentIndex - 1 + tabPaneIds.length) % tabPaneIds.length;
        if (tabPaneIds[nextIndex]) {
          state.setActivePane(tabPaneIds[nextIndex]);
        }
      }

      // Ctrl+Tab / Ctrl+Shift+Tab to switch tabs
      if (e.key === 'Tab') {
        e.preventDefault();
        const tabIndex = workspace.tabs.findIndex(t => t.id === activeTabId);
        const nextIndex = e.shiftKey
          ? (tabIndex - 1 + workspace.tabs.length) % workspace.tabs.length
          : (tabIndex + 1) % workspace.tabs.length;
        if (workspace.tabs[nextIndex]) setActiveTab(workspace.tabs[nextIndex].id);
      }

      // Ctrl+F to toggle search
      if (e.key === 'f') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-search'));
      }

      // Ctrl+Shift+V to toggle visualizer
      if (e.shiftKey && e.key === 'V') {
        e.preventDefault();
        useVisualizerStore.getState().toggleVisible();
      }

      // Ctrl+, to toggle settings
      if (e.key === ',') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-settings'));
      }

      // Ctrl+/ to toggle shortcuts
      if (e.key === '/') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-shortcuts'));
      }

      // Ctrl+1-9 to switch tabs
      if (e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key) - 1;
        const tab = workspace.tabs[index];
        if (tab) setActiveTab(tab.id);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspace, activeTabId, activePaneId, addTab, closePane, splitPane, setActiveTab]);
}
