import { useEffect, useRef, useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { PaneGrid } from './components/PaneGrid';
import { useWorkspaceStore, collectPaneIds } from './store/workspace-store';
import { usePaneNavigation } from './hooks/use-pane-navigation';
import { useNotifications } from './hooks/use-notifications';
import { useNotificationStore } from './store/notification-store';

const UNDO_TOAST_DURATION = 5000;

export function App() {
  usePaneNavigation();
  useNotifications();
  const initRef = useRef(false);
  const [showUndoToast, setShowUndoToast] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { workspace, activeTabId, activePaneId, setActivePane, addTab, lastClosedTab, undoCloseTab } =
    useWorkspaceStore();

  // Create a default tab on first load if workspace is empty
  useEffect(() => {
    if (!initRef.current && workspace.tabs.length === 0) {
      initRef.current = true;
      addTab('Shell', window.fleet.homeDir);
    }
  }, []);

  // Show undo toast when a tab is closed
  useEffect(() => {
    if (lastClosedTab) {
      setShowUndoToast(true);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      undoTimerRef.current = setTimeout(() => setShowUndoToast(false), UNDO_TOAST_DURATION);
    }
  }, [lastClosedTab]);

  const handleUndo = useCallback(() => {
    undoCloseTab();
    setShowUndoToast(false);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, [undoCloseTab]);

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
                  useNotificationStore.getState().clearPane(paneId);
                }}
              />
            </div>
          ))
        ) : (
          <div className="flex items-center justify-center h-full text-neutral-600">
            No tabs open. Press Cmd+T to create one.
          </div>
        )}
        {/* Undo close tab toast (NNG: undo > confirmation dialogs for divided-attention UX) */}
        {showUndoToast && lastClosedTab && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg text-sm">
            <span className="text-neutral-300">
              Closed "{lastClosedTab.tab.label}"
            </span>
            <button
              className="text-blue-400 hover:text-blue-300 font-medium"
              onClick={handleUndo}
            >
              Undo
            </button>
            <button
              className="text-neutral-500 hover:text-neutral-300"
              onClick={() => setShowUndoToast(false)}
            >
              ×
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
