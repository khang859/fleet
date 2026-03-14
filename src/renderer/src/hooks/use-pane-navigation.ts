import { useEffect } from 'react';
import { useWorkspaceStore } from '../store/workspace-store';

export function usePaneNavigation() {
  const { workspace, activeTabId, activePaneId, addTab, closePane, splitPane, setActiveTab } =
    useWorkspaceStore();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === 't') {
        e.preventDefault();
        addTab('Shell', window.fleet.homeDir);
      }

      if (mod && e.key === 'w') {
        e.preventDefault();
        if (activePaneId) closePane(activePaneId);
      }

      if (mod && e.key === 'd' && !e.shiftKey) {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'horizontal');
      }

      if (mod && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'vertical');
      }

      // Cmd+[ / Cmd+] to navigate panes
      if (mod && (e.key === '[' || e.key === ']')) {
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

      // Cmd+F to toggle search
      if (mod && e.key === 'f') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-search'));
      }

      // Cmd+1-9 to switch tabs
      if (mod && e.key >= '1' && e.key <= '9') {
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
