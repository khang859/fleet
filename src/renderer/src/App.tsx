import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Terminal, ImageIcon, Settings } from 'lucide-react';
import { getFileIcon } from './lib/file-icons';
import { Sidebar } from './components/Sidebar';
import { PaneGrid } from './components/PaneGrid';
import { useWorkspaceStore, collectPaneIds, collectPaneLeafs } from './store/workspace-store';
import { usePaneNavigation } from './hooks/use-pane-navigation';
import { useNotifications } from './hooks/use-notifications';
import { useNotificationStore } from './store/notification-store';
import { clearCreatedPty, markPtyCreated, serializePane } from './hooks/use-terminal';
import { initCwdListener, useCwdStore } from './store/cwd-store';
import { useSettingsStore } from './store/settings-store';
import { injectLiveCwd } from './lib/workspace-utils';
import { VisualizerPanel } from './components/visualizer/VisualizerPanel';
import { ShortcutsHint } from './components/ShortcutsHint';
import { SettingsModal } from './components/SettingsModal';
import { ShortcutsPanel } from './components/ShortcutsPanel';
import { CommandPalette } from './components/CommandPalette';
import { GitChangesModal } from './components/GitChangesModal';
import { QuickOpenOverlay } from './components/QuickOpenOverlay';
import { FileBrowserDrawer } from './components/FileBrowserDrawer';
import { FileSearchOverlay } from './components/FileSearchOverlay';
import { StarCommandTab } from './components/StarCommandTab';
import { Avatar } from './components/star-command/Avatar';
import { AppPreChecks } from './components/AppPreChecks';

const UNDO_TOAST_DURATION = 5000;
const PTY_GC_INTERVAL = 30_000; // 30 seconds

function killClosedTabPtys(paneIds: string[]): void {
  for (const paneId of paneIds) {
    window.fleet.pty.kill(paneId);
    clearCreatedPty(paneId);
  }
}


export function App(): React.JSX.Element {
  usePaneNavigation();
  useNotifications();
  const { loadSettings } = useSettingsStore();
  const initRef = useRef(false);
  const [showUndoToast, setShowUndoToast] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sidebarManualOpen, setSidebarManualOpen] = useState(false);

  const {
    workspace,
    backgroundWorkspaces,
    activeTabId,
    activePaneId,
    setActiveTab,
    setActivePane,
    addTab,
    lastClosedTab,
    undoCloseTab
  } = useWorkspaceStore(useShallow((s) => ({
    workspace: s.workspace,
    backgroundWorkspaces: s.backgroundWorkspaces,
    activeTabId: s.activeTabId,
    activePaneId: s.activePaneId,
    setActiveTab: s.setActiveTab,
    setActivePane: s.setActivePane,
    addTab: s.addTab,
    lastClosedTab: s.lastClosedTab,
    undoCloseTab: s.undoCloseTab
  })));
  const settings = useSettingsStore((s) => s.settings);
  const focusedPaneCwd = useCwdStore((s) => (activePaneId ? s.cwds.get(activePaneId) : undefined));

  const isStarCommand = useMemo(
    () => workspace.tabs.find((t) => t.id === activeTabId)?.type === 'star-command',
    [workspace.tabs, activeTabId]
  );
  const showSidebar = !isStarCommand || sidebarManualOpen;

  // Reset manual override when leaving star-command
  useEffect(() => {
    if (!isStarCommand) setSidebarManualOpen(false);
  }, [isStarCommand]);

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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [gitChangesOpen, setGitChangesOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [showPreChecks, setShowPreChecks] = useState(true);

  // Load settings on startup
  useEffect(() => {
    void loadSettings();
  }, []);

  // Subscribe to live CWD updates from main process
  useEffect(() => {
    return initCwdListener();
  }, []);

  // Settings modal toggle
  useEffect(() => {
    const handler = (): void => setSettingsOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-settings', handler);
    return () => document.removeEventListener('fleet:toggle-settings', handler);
  }, []);

  // Shortcuts panel toggle
  useEffect(() => {
    const handler = (): void => setShortcutsOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-shortcuts', handler);
    return () => document.removeEventListener('fleet:toggle-shortcuts', handler);
  }, []);

  // Command palette toggle
  useEffect(() => {
    const handler = (): void => setCommandPaletteOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-command-palette', handler);
    return () => document.removeEventListener('fleet:toggle-command-palette', handler);
  }, []);

  // Git changes modal toggle
  useEffect(() => {
    const handler = (): void => setGitChangesOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-git-changes', handler);
    return () => document.removeEventListener('fleet:toggle-git-changes', handler);
  }, []);

  // Quick open toggle (Cmd+P)
  useEffect(() => {
    const handler = (): void => setQuickOpenOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-quick-open', handler);
    return () => document.removeEventListener('fleet:toggle-quick-open', handler);
  }, []);

  // File browser drawer toggle (Cmd+Shift+E or toolbar button)
  useEffect(() => {
    const handler = (): void => setFileBrowserOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-file-browser', handler);
    return () => document.removeEventListener('fleet:toggle-file-browser', handler);
  }, []);

  // File search overlay toggle (Cmd+Shift+O or command palette)
  useEffect(() => {
    const handler = (): void => setFileSearchOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-file-search', handler);
    return () => document.removeEventListener('fleet:toggle-file-search', handler);
  }, []);

  // Open file dialog (Cmd+O)
  useEffect(() => {
    const handler = (): void => {
      const cwd = focusedPaneCwd ?? window.fleet.homeDir;
      void window.fleet.file.openDialog({ defaultPath: cwd }).then((filePaths) => {
        for (const filePath of filePaths) {
          useWorkspaceStore.getState().openFile(filePath);
        }
      });
    };
    document.addEventListener('fleet:open-file-dialog', handler);
    return () => document.removeEventListener('fleet:open-file-dialog', handler);
  }, [focusedPaneCwd]);

  // TODO(#30): Crew tabs are no longer created — crews are now headless (stream-json).
  // This listener remains for backwards compatibility but will not fire for new deployments.
  // Remove when crew tab UI is fully deprecated.
  useEffect(() => {
    const cleanup = window.fleet.onCreateTab(({ tabId, label, cwd, avatarVariant }) => {
      markPtyCreated(tabId);
      useWorkspaceStore.getState().addCrewTab(tabId, label, cwd, avatarVariant);
    });
    return () => {
      cleanup();
    };
  }, []);

  // Open file in tab via IPC (fleet file:open-in-tab, with dedup)
  useEffect(() => {
    const cleanup = window.fleet.file.onOpenInTab((payload) => {
      useWorkspaceStore.getState().openFileInTab(payload.files);
    });
    return () => {
      cleanup();
    };
  }, []);

  // Auto-updater
  useEffect(() => {
    const cleanup = window.fleet.updates.onUpdateStatus((status) => {
      if (status.state === 'ready') setUpdateReady(true);
    });
    return () => {
      cleanup();
    };
  }, []);

  // Restore default workspace on startup, or create a fresh tab
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void window.fleet.layout.list().then(({ workspaces }) => {
      const defaultWs = workspaces.find((w) => w.id === 'default');
      const others = workspaces.filter((w) => w.id !== 'default');

      if (defaultWs && defaultWs.tabs.length > 0) {
        useWorkspaceStore.getState().loadWorkspace(defaultWs);
      } else if (workspace.tabs.length === 0) {
        addTab(undefined, window.fleet.homeDir);
      }

      // Load all other saved workspaces into background so their PTYs warm up
      if (others.length > 0) {
        useWorkspaceStore.getState().loadBackgroundWorkspaces(others);
      }
    });
  }, []);

  // Best-effort flush on page hide; debounced autosave remains the primary durability path.
  useEffect(() => {
    const flushWorkspace = (): void => {
      const state = useWorkspaceStore.getState();

      // Save active workspace (without terminal scrollback — tabs restore with a clean terminal)
      const activeWithContent = {
        ...state.workspace,
        activeTabId: state.activeTabId ?? undefined,
        activePaneId: state.activePaneId ?? undefined,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: injectLiveCwd(tab.splitRoot)
        }))
      };
      void window.fleet.layout.save({ workspace: activeWithContent });

      // Save background workspaces
      for (const bgWs of state.backgroundWorkspaces.values()) {
        const bgWithContent = {
          ...bgWs,
          tabs: bgWs.tabs.map((tab) => ({
            ...tab,
            splitRoot: injectLiveCwd(tab.splitRoot)
          }))
        };
        void window.fleet.layout.save({ workspace: bgWithContent });
      }
    };
    const handlePageHide = (): void => {
      flushWorkspace();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        flushWorkspace();
      }
    };
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
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

      // Search active workspace first, then background workspaces
      let tab = state.workspace.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId));
      const isBackground = !tab;
      if (!tab) {
        for (const bgWs of state.backgroundWorkspaces.values()) {
          tab = bgWs.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId));
          if (tab) break;
        }
      }
      if (!tab) return;

      // Crew tabs: close silently (no undo toast — automated agent, PTY is dead)
      if (tab.type === 'crew') {
        state.closeTab(tab.id);
        return;
      }

      // Background workspace tabs: close without undo toast (user isn't looking at them)
      if (isBackground) {
        state.closeTab(tab.id);
        return;
      }

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
    return () => {
      cleanup();
    };
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen bg-neutral-950 text-white overflow-hidden">
      {/* Top bar — drag region for window movement, houses OS window controls */}
      <div
        className="h-9 shrink-0 bg-neutral-950 flex items-center"
        style={{ WebkitAppRegion: 'drag' }}
      >
        <ShortcutsHint />
      </div>
      <div className="flex flex-1 min-h-0">
        {showSidebar ? (
          <Sidebar
            updateReady={updateReady}
            onCollapse={isStarCommand ? () => setSidebarManualOpen(false) : undefined}
          />
        ) : (
          <div
            className="flex flex-col items-center h-full w-11 bg-neutral-900 border-r border-neutral-800 shrink-0 py-2 gap-1"
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            {/* Expand sidebar button */}
            <button
              onClick={() => setSidebarManualOpen(true)}
              className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
              title="Show sidebar"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <rect x="1" y="2" width="14" height="12" rx="2" />
                <line x1="5.5" y1="2" x2="5.5" y2="14" />
              </svg>
            </button>
            <div className="w-6 h-px bg-neutral-800 my-0.5" />
            {/* Tab icons */}
            {workspace.tabs
              .filter((t) => t.type !== 'star-command')
              .map((tab) => {
                const isActive = tab.id === activeTabId;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`p-1 rounded transition-colors ${
                      isActive ? 'bg-neutral-700 ring-1 ring-neutral-600' : 'hover:bg-neutral-800'
                    }`}
                    title={tab.label}
                  >
                    {tab.type === 'crew' ? (
                      <Avatar type="crew" variant={tab.avatarVariant} size={20} />
                    ) : tab.type === 'file' ? (
                      <span className={isActive ? 'text-white' : 'text-neutral-500'}>
                        {getFileIcon(
                          collectPaneLeafs(tab.splitRoot)[0]?.filePath?.split('/').pop() ??
                            tab.label,
                          16
                        )}
                      </span>
                    ) : tab.type === 'image' ? (
                      <ImageIcon
                        size={16}
                        className={isActive ? 'text-white' : 'text-neutral-500'}
                      />
                    ) : (
                      <Terminal
                        size={16}
                        className={isActive ? 'text-white' : 'text-neutral-500'}
                      />
                    )}
                  </button>
                );
              })}
            <div className="flex-1" />
            {/* Settings button */}
            <button
              onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-settings'))}
              className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
              title="Settings"
            >
              <Settings size={16} />
            </button>
          </div>
        )}
        <div className="flex-1 min-w-0 h-full flex flex-col">
          <main className="flex-1 min-w-0 relative overflow-hidden">
            {workspace.tabs.length > 0 || backgroundWorkspaces.size > 0 ? (
              <>
                {workspace.tabs.map((tab) => {
                  const serializedPanes = restoredPanesRef.current.get(tab.id);
                  return (
                    <div
                      key={tab.id}
                      className="h-full w-full"
                      style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
                    >
                      {tab.type === 'star-command' ? (
                        <StarCommandTab />
                      ) : (
                        <PaneGrid
                          root={tab.splitRoot}
                          activePaneId={tab.id === activeTabId ? activePaneId : null}
                          onPaneFocus={(paneId) => {
                            setActivePane(paneId);
                            window.fleet.notifications.paneFocused({ paneId });
                            useNotificationStore.getState().clearPane(paneId);
                          }}
                          serializedPanes={serializedPanes}
                          fontFamily={settings?.general.fontFamily}
                          fontSize={settings?.general.fontSize}
                        />
                      )}
                    </div>
                  );
                })}
                {Array.from(backgroundWorkspaces.values()).flatMap((bgWs) =>
                  bgWs.tabs.map((tab) => (
                    <div key={tab.id} className="h-full w-full" style={{ display: 'none' }}>
                      {tab.type !== 'star-command' && (
                        <PaneGrid
                          root={tab.splitRoot}
                          activePaneId={null}
                          onPaneFocus={() => {}}
                          serializedPanes={undefined}
                          fontFamily={settings?.general.fontFamily}
                          fontSize={settings?.general.fontSize}
                        />
                      )}
                    </div>
                  ))
                )}
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-neutral-600">
                No tabs open. Press Cmd+T to create one.
              </div>
            )}
            {/* Undo close tab toast (NNG: undo > confirmation dialogs for divided-attention UX) */}
            {showUndoToast && lastClosedTab && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg text-sm">
                <span className="text-neutral-300">Closed {'"'}{lastClosedTab.tab.label}{'"'}</span>
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
        {/* end content column */}
      </div>
      {/* end sidebar+content row */}
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsPanel isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette isOpen={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      <GitChangesModal
        isOpen={gitChangesOpen}
        onClose={() => setGitChangesOpen(false)}
        cwd={focusedPaneCwd}
      />
      <QuickOpenOverlay
        isOpen={quickOpenOpen}
        onClose={() => setQuickOpenOpen(false)}
        rootDir={focusedPaneCwd}
      />
      <FileBrowserDrawer isOpen={fileBrowserOpen} onClose={() => setFileBrowserOpen(false)} />
      <FileSearchOverlay isOpen={fileSearchOpen} onClose={() => setFileSearchOpen(false)} />
      {showPreChecks && <AppPreChecks onDismiss={() => setShowPreChecks(false)} />}
    </div>
  );
}
