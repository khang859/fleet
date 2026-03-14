import { useEffect, useRef, useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { PaneGrid } from './components/PaneGrid';
import { useWorkspaceStore, collectPaneIds } from './store/workspace-store';
import { usePaneNavigation } from './hooks/use-pane-navigation';
import { useNotifications } from './hooks/use-notifications';
import { useNotificationStore } from './store/notification-store';
import { clearCreatedPty, serializePane } from './hooks/use-terminal';
import { useVisualizerStore } from './store/visualizer-store';
import { useSettingsStore } from './store/settings-store';
import { VisualizerPanel } from './components/visualizer/VisualizerPanel';
import { ShortcutsHint } from './components/ShortcutsHint';
import { SettingsModal } from './components/SettingsModal';
import { ShortcutsPanel } from './components/ShortcutsPanel';

const UNDO_TOAST_DURATION = 5000;
const PTY_GC_INTERVAL = 30_000; // 30 seconds

function killClosedTabPtys(paneIds: string[]): void {
  for (const paneId of paneIds) {
    window.fleet.pty.kill(paneId);
    clearCreatedPty(paneId);
  }
}

export function App() {
  usePaneNavigation();
  useNotifications();
  const { loadSettings } = useSettingsStore();
  const initRef = useRef(false);
  const [showUndoToast, setShowUndoToast] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { workspace, activeTabId, activePaneId, setActivePane, addTab, lastClosedTab, undoCloseTab } =
    useWorkspaceStore();

  // Track serialized pane content for restored tabs (consumed once on mount)
  const restoredPanesRef = useRef<Map<string, Map<string, string>>>(new Map());

  // Clean up consumed entries after mount (can't delete during render due to StrictMode)
  useEffect(() => {
    if (restoredPanesRef.current.size > 0) {
      restoredPanesRef.current.clear();
    }
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);

  // Load settings on startup
  useEffect(() => {
    loadSettings();
  }, []);

  // Settings modal toggle
  useEffect(() => {
    const handler = () => setSettingsOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-settings', handler);
    return () => document.removeEventListener('fleet:toggle-settings', handler);
  }, []);

  // Shortcuts panel toggle
  useEffect(() => {
    const handler = () => setShortcutsOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-shortcuts', handler);
    return () => document.removeEventListener('fleet:toggle-shortcuts', handler);
  }, []);

  // Auto-updater
  useEffect(() => {
    const cleanup = window.fleet.updates.onUpdateDownloaded(() => {
      setUpdateReady(true);
    });
    return () => { cleanup(); };
  }, []);

  // Restore default workspace on startup, or create a fresh tab
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    window.fleet.layout.list().then(({ workspaces }) => {
      const defaultWs = workspaces.find((w) => w.id === 'default');
      if (defaultWs && defaultWs.tabs.length > 0) {
        useWorkspaceStore.getState().loadWorkspace(defaultWs);
      } else if (workspace.tabs.length === 0) {
        addTab(undefined, window.fleet.homeDir);
      }
    });
  }, []);

  // Auto-save workspace on quit
  useEffect(() => {
    const handleBeforeUnload = () => {
      const state = useWorkspaceStore.getState();
      window.fleet.layout.save({ workspace: state.workspace });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Track pane IDs pending kill so we can clean up the previous batch
  const pendingKillRef = useRef<string[]>([]);

  // Show undo toast when a tab is closed; kill PTYs when undo window expires
  useEffect(() => {
    if (lastClosedTab) {
      // Kill PTYs from any previous closed tab that wasn't undone
      if (pendingKillRef.current.length > 0) {
        killClosedTabPtys(pendingKillRef.current);
      }
      setShowUndoToast(true);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      const paneIds = collectPaneIds(lastClosedTab.tab.splitRoot);
      pendingKillRef.current = paneIds;
      undoTimerRef.current = setTimeout(() => {
        setShowUndoToast(false);
        killClosedTabPtys(paneIds);
        pendingKillRef.current = [];
      }, UNDO_TOAST_DURATION);
    }
  }, [lastClosedTab]);

  const handleUndo = useCallback(() => {
    const closed = useWorkspaceStore.getState().lastClosedTab;
    if (closed && closed.serializedPanes.size > 0) {
      restoredPanesRef.current.set(closed.tab.id, closed.serializedPanes);
    }
    undoCloseTab();
    setShowUndoToast(false);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    pendingKillRef.current = [];
  }, [undoCloseTab]);

  // Periodic GC: kill orphaned PTYs that have no corresponding pane in the workspace
  useEffect(() => {
    const interval = setInterval(() => {
      const state = useWorkspaceStore.getState();
      const activePaneIds = state.getAllPaneIds();
      // Also include panes pending undo — they're still alive intentionally
      const allValid = [...activePaneIds, ...pendingKillRef.current];
      window.fleet.pty.gc(allValid);
    }, PTY_GC_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  // Handle PTY exit
  useEffect(() => {
    const cleanup = window.fleet.pty.onExit(({ paneId }) => {
      clearCreatedPty(paneId);
      const state = useWorkspaceStore.getState();
      const tab = state.workspace.tabs.find((t) =>
        collectPaneIds(t.splitRoot).includes(paneId),
      );
      if (!tab) return;

      const paneIds = collectPaneIds(tab.splitRoot);
      if (paneIds.length === 1) {
        // Serialize all panes before closing tab
        const serializedPanes = new Map<string, string>();
        for (const id of paneIds) {
          const content = serializePane(id);
          if (content) serializedPanes.set(id, content);
        }
        state.closeTab(tab.id, serializedPanes);
      } else {
        state.closePane(paneId);
      }
    });
    return () => { cleanup(); };
  }, []);

  return (
    <div className="flex h-screen w-screen bg-neutral-950 text-white overflow-hidden">
      <Sidebar />
      <div className="flex-1 min-w-0 h-full flex flex-col">
      <main className="flex-1 min-w-0 relative overflow-hidden">
        {/* Top drag region for window movement */}
        <div
          className="absolute top-0 left-0 right-0 h-8 z-10"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />
        {workspace.tabs.length > 0 ? (
          workspace.tabs.map((tab) => {
            const serializedPanes = restoredPanesRef.current.get(tab.id);
            return (
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
                  serializedPanes={serializedPanes}
                />
              </div>
            );
          })
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
              onClick={() => {
                setShowUndoToast(false);
                if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
                if (lastClosedTab) {
                  killClosedTabPtys(collectPaneIds(lastClosedTab.tab.splitRoot));
                  pendingKillRef.current = [];
                }
              }}
            >
              ×
            </button>
          </div>
        )}
        <ShortcutsHint />
      </main>
      <VisualizerPanel
        onShipClick={(id) => {
          // id might be a tab ID (parent ship) or pane ID (child ship)
          const tab = workspace.tabs.find((t) => t.id === id);
          if (tab) {
            // Clicked a tab ship — switch to that tab and focus its first pane
            const { setActiveTab } = useWorkspaceStore.getState();
            setActiveTab(tab.id);
            const paneIds = collectPaneIds(tab.splitRoot);
            if (paneIds[0]) setActivePane(paneIds[0]);
          } else {
            // Clicked a pane ship — focus that pane
            setActivePane(id);
            window.fleet.notifications.paneFocused({ paneId: id });
          }
        }}
      />
      </div>
      {updateReady && (
        <div className="absolute bottom-4 right-4 z-40">
          <button
            onClick={() => window.fleet.updates.installUpdate()}
            className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md shadow-lg"
          >
            Update ready — restart to install
          </button>
        </div>
      )}
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsPanel isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
