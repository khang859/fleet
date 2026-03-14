import { useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { PaneGrid } from './components/PaneGrid';
import { useWorkspaceStore, collectPaneIds } from './store/workspace-store';
import { usePaneNavigation } from './hooks/use-pane-navigation';

export function App() {
  usePaneNavigation();
  const initRef = useRef(false);

  const { workspace, activeTabId, activePaneId, setActivePane, addTab } =
    useWorkspaceStore();

  // Create a default tab on first load if workspace is empty
  useEffect(() => {
    if (!initRef.current && workspace.tabs.length === 0) {
      initRef.current = true;
      addTab('Shell', window.fleet.homeDir);
    }
  }, []);

  // Handle PTY exit
  useEffect(() => {
    const cleanup = window.fleet.pty.onExit(({ paneId }) => {
      const state = useWorkspaceStore.getState();
      const tab = state.workspace.tabs.find((t) =>
        collectPaneIds(t.splitRoot).includes(paneId),
      );
      if (!tab) return;

      const paneIds = collectPaneIds(tab.splitRoot);
      if (paneIds.length === 1) {
        state.closeTab(tab.id);
      } else {
        state.closePane(paneId);
      }
    });
    return () => { cleanup(); };
  }, []);

  return (
    <div className="flex h-screen w-screen bg-neutral-950 text-white overflow-hidden">
      <Sidebar />
      <main className="flex-1 min-w-0 h-full relative">
        {/* Top drag region for window movement */}
        <div
          className="absolute top-0 left-0 right-0 h-8 z-10"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />
        {workspace.tabs.length > 0 ? (
          workspace.tabs.map((tab) => (
            <div
              key={tab.id}
              className="h-full w-full"
              style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
            >
              <PaneGrid
                root={tab.splitRoot}
                activePaneId={tab.id === activeTabId ? activePaneId : null}
                onPaneFocus={(paneId) => {
                  setActivePane(paneId);
                  window.fleet.notifications.paneFocused({ paneId });
                }}
              />
            </div>
          ))
        ) : (
          <div className="flex items-center justify-center h-full text-neutral-600">
            No tabs open. Press Cmd+T to create one.
          </div>
        )}
      </main>
    </div>
  );
}
