import { useEffect } from 'react';
import { useWorkspaceStore } from '../store/workspace-store';
import { useVisualizerStore } from '../store/visualizer-store';

export function usePaneNavigation() {
  const { workspace, activeTabId, activePaneId, addTab, closePane, splitPane, setActiveTab } =
    useWorkspaceStore();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey) return;

      if (e.key === 't') {
        e.preventDefault();
        addTab('Shell', window.fleet.homeDir);
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

      // Ctrl+[ / Ctrl+] to navigate panes
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const allPaneIds = useWorkspaceStore.getState().getAllPaneIds();
        const currentIndex = activePaneId ? allPaneIds.indexOf(activePaneId) : -1;
        const nextIndex = e.key === ']'
          ? (currentIndex + 1) % allPaneIds.length
          : (currentIndex - 1 + allPaneIds.length) % allPaneIds.length;
        if (allPaneIds[nextIndex]) {
          useWorkspaceStore.getState().setActivePane(allPaneIds[nextIndex]);
        }
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
