import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Terminal,
  ImageIcon,
  Settings,
  Crosshair,
  KanbanSquare,
  History,
  SlidersHorizontal,
  MessageSquare
} from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Popover from '@radix-ui/react-popover';
import { getFileIcon } from './lib/file-icons';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { PaneGrid } from './components/PaneGrid';
import {
  useWorkspaceStore,
  collectPaneIds,
  collectPaneLeafs,
  getPaneContextById
} from './store/workspace-store';
import { usePaneNavigation } from './hooks/use-pane-navigation';
import { useNotifications } from './hooks/use-notifications';
import { useRuneAssistEvents } from './hooks/use-rune-assist-events';
import { useNotificationStore } from './store/notification-store';
import { clearCreatedPty, restartingPanes, serializePane } from './hooks/use-terminal';
import { initCwdListener, useCwdStore } from './store/cwd-store';
import { initRemoteListener } from './store/remote-store';
import { useSettingsStore } from './store/settings-store';
import { useShellProfilesStore } from './store/shell-profiles-store';
import { useHomesStore } from './store/homes-store';
import { useKanbanStore } from './store/kanban-store';
import { injectLiveCwd } from './lib/workspace-utils';
import { VisualizerPanel } from './components/visualizer/VisualizerPanel';
import { ShortcutsHint } from './components/ShortcutsHint';
import { SettingsTab } from './components/settings/SettingsTab';
import { ShortcutsPanel } from './components/ShortcutsPanel';
import { CommandPalette } from './components/CommandPalette';
import { GitChangesModal } from './components/GitChangesModal';
import { QuickOpenOverlay } from './components/QuickOpenOverlay';
import { FileSearchOverlay } from './components/FileSearchOverlay';
import { ClipboardHistoryOverlay } from './components/ClipboardHistoryOverlay';
import { ToolsConfigModal } from './components/ToolsConfigModal';
import { TelescopeModal } from './components/Telescope/TelescopeModal';
import { EnvSyncModal } from './components/env-sync/EnvSyncModal';
import { EnvEditorModal } from './components/env-editor/EnvEditorModal';
import { ImageGallery } from './components/ImageGallery/ImageGallery';
import { AnnotateTab } from './components/AnnotateTab';
import { PiTab } from './components/PiTab';
import { KanbanBoard } from './components/kanban/KanbanBoard';
import { SessionsTab } from './components/sessions/SessionsTab';
import { ChatTab } from './components/chat/ChatTab';
import { PiPlanModal } from './components/PiPlanModal';
import { AnnotateModal } from './components/AnnotateModal';
import { ToastContainer } from './components/ToastContainer';
import type { PiPlanOpenPayload } from '../../shared/ipc-api';
import { useKanbanAttention } from './hooks/useKanbanAttention';
import { getAccentCssVars } from './lib/theme';
import { tooltipAnim, popperAnim } from './lib/motion';
import { useAppThemeVars } from './hooks/use-app-theme';
import { useSlideshow } from './hooks/use-slideshow';
import { findPaneLocation } from './lib/palette-items';

type PiPlanModalEntry = PiPlanOpenPayload & { modalId: string };

function MiniSidebarTooltip({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="right"
            sideOffset={8}
            className={`px-2 py-1 text-xs text-fleet-text bg-fleet-surface-2 border border-fleet-border-strong rounded shadow-lg z-50 ${tooltipAnim}`}
          >
            {label}
            <Tooltip.Arrow className="fill-fleet-surface-2" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

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
  useKanbanAttention();
  useRuneAssistEvents();
  const { loadSettings } = useSettingsStore();
  const initRef = useRef(false);
  const [showUndoToast, setShowUndoToast] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [miniWsOpen, setMiniWsOpen] = useState(false);
  const [miniWsList, setMiniWsList] = useState<
    Array<{ id: string; label: string; tabCount: number }>
  >([]);

  const {
    workspace,
    backgroundWorkspaces,
    activeTabId,
    activePaneId,
    setActiveTab,
    setActivePane,
    addTab,
    lastClosedTab,
    undoCloseTab,
    recentFiles,
    recentFolders,
    openFile
  } = useWorkspaceStore(
    useShallow((s) => ({
      workspace: s.workspace,
      backgroundWorkspaces: s.backgroundWorkspaces,
      activeTabId: s.activeTabId,
      activePaneId: s.activePaneId,
      setActiveTab: s.setActiveTab,
      setActivePane: s.setActivePane,
      addTab: s.addTab,
      lastClosedTab: s.lastClosedTab,
      undoCloseTab: s.undoCloseTab,
      recentFiles: s.recentFiles,
      recentFolders: s.recentFolders,
      openFile: s.openFile
    }))
  );
  const settings = useSettingsStore((s) => s.settings);
  const focusedPaneCwd = useCwdStore((s) => (activePaneId ? s.cwds.get(activePaneId) : undefined));
  // Stable per-pane reference so consumers can safely use it in effect deps
  // (getPaneContextById returns a fresh object for WSL panes on every call).
  const activePathContext = useMemo(() => getPaneContextById(activePaneId), [activePaneId]);

  // Track serialized pane content for restored tabs (consumed once on mount)
  const restoredPanesRef = useRef<Map<string, Map<string, string>>>(new Map());

  // Clean up consumed entries after mount (can't delete during render due to StrictMode)
  useEffect(() => {
    if (restoredPanesRef.current.size > 0) {
      restoredPanesRef.current.clear();
    }
  });

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [gitChangesOpen, setGitChangesOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [clipboardHistoryOpen, setClipboardHistoryOpen] = useState(false);
  const [toolsConfigOpen, setToolsConfigOpen] = useState(false);
  const [telescopeOpen, setTelescopeOpen] = useState(false);
  const [envSyncOpen, setEnvSyncOpen] = useState(false);
  const [envEditorOpen, setEnvEditorOpen] = useState(false);
  const [planModalQueue, setPlanModalQueue] = useState<PiPlanModalEntry[]>([]);
  const [updateReady, setUpdateReady] = useState(false);

  // Load settings on startup
  useEffect(() => {
    void loadSettings();
  }, []);

  // Reconcile pinned tool tabs whenever the visibility preference changes
  // (also corrects the settings-load-vs-workspace-load race on startup).
  const toolVisibility = settings?.tools;
  useEffect(() => {
    if (toolVisibility) {
      useWorkspaceStore.getState().reconcileToolTabs();
    }
  }, [toolVisibility]);

  // Load shell profiles on startup; warm the WSL home cache so displayPath
  // can collapse `/home/<user>` to `~` in Telescope subtitles.
  useEffect(() => {
    void useShellProfilesStore
      .getState()
      .load()
      .then(() => {
        for (const p of useShellProfilesStore.getState().profiles) {
          if (typeof p.pathContext === 'object' && p.pathContext.kind === 'wsl') {
            void useHomesStore.getState().ensureWslHome(p.pathContext.distro);
          }
        }
      });
  }, []);

  // Subscribe to live CWD updates from main process
  useEffect(() => {
    return initCwdListener();
  }, []);

  // Subscribe to remote-session (ssh/mosh) state from main process
  useEffect(() => {
    return initRemoteListener();
  }, []);

  // Listen for focus-pane from main process (copilot "Go to Terminal", OS notifications)
  useEffect(() => {
    return window.fleet.notifications.onFocusPane(({ paneId }) => {
      const state = useWorkspaceStore.getState();
      // Find which tab contains this pane
      const tab = state.workspace.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId));
      if (tab) {
        useWorkspaceStore.setState({ activeTabId: tab.id, activePaneId: paneId });
      }
    });
  }, []);

  // Settings tab toggle — create singleton or focus existing
  useEffect(() => {
    const handler = (): void => {
      const state = useWorkspaceStore.getState();
      const existing = state.workspace.tabs.find((t) => t.type === 'settings');
      if (existing) {
        state.setActiveTab(existing.id);
      } else {
        const leaf = { type: 'leaf' as const, id: crypto.randomUUID(), cwd: '/' };
        const tab = {
          id: crypto.randomUUID(),
          label: 'Settings',
          labelIsCustom: true,
          cwd: '/',
          type: 'settings' as const,
          splitRoot: leaf
        };
        useWorkspaceStore.setState((s) => ({
          workspace: { ...s.workspace, tabs: [...s.workspace.tabs, tab] },
          activeTabId: tab.id,
          activePaneId: leaf.id,
          isDirty: true
        }));
      }
    };
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

  // Jump to first pane that needs input
  useEffect(() => {
    const handler = (): void => {
      const activities = useNotificationStore.getState().activities;
      const ws = useWorkspaceStore.getState();
      for (const [paneId, rec] of activities) {
        if (rec.state === 'needs_me') {
          const loc = findPaneLocation(ws.workspace.tabs, paneId);
          if (loc) {
            ws.setActiveTab(loc.tabId);
            ws.setActivePane(paneId);
          }
          break;
        }
      }
    };
    document.addEventListener('fleet:jump-needy-agent', handler);
    return () => document.removeEventListener('fleet:jump-needy-agent', handler);
  }, []);

  // Git changes modal toggle
  useEffect(() => {
    const handler = (): void => setGitChangesOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-git-changes', handler);
    return () => document.removeEventListener('fleet:toggle-git-changes', handler);
  }, []);

  // Env sync modal toggle
  useEffect(() => {
    const handler = (): void => setEnvSyncOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-env-sync', handler);
    return () => document.removeEventListener('fleet:toggle-env-sync', handler);
  }, []);

  // Env editor modal toggle
  useEffect(() => {
    const handler = (): void => setEnvEditorOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-env-editor', handler);
    return () => document.removeEventListener('fleet:toggle-env-editor', handler);
  }, []);

  // Quick open toggle (Cmd+P)
  useEffect(() => {
    const handler = (): void => setQuickOpenOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-quick-open', handler);
    return () => document.removeEventListener('fleet:toggle-quick-open', handler);
  }, []);

  // File search overlay toggle (Cmd+Shift+O or command palette)
  useEffect(() => {
    const handler = (): void => setFileSearchOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-file-search', handler);
    return () => document.removeEventListener('fleet:toggle-file-search', handler);
  }, []);

  // Clipboard history overlay toggle (Cmd+Shift+H)
  useEffect(() => {
    const handler = (): void => setClipboardHistoryOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-clipboard-history', handler);
    return () => document.removeEventListener('fleet:toggle-clipboard-history', handler);
  }, []);

  // Telescope modal toggle (Cmd+Shift+T)
  useEffect(() => {
    const handler = (): void => setTelescopeOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-telescope', handler);
    return () => document.removeEventListener('fleet:toggle-telescope', handler);
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

  // Open file in tab via IPC (fleet file:open-in-tab, with dedup)
  useEffect(() => {
    const cleanup = window.fleet.file.onOpenInTab((payload) => {
      useWorkspaceStore.getState().openFileInTab(payload.files);
    });
    return () => {
      cleanup();
    };
  }, []);

  // Open Pi agent tab via IPC (fleet pi CLI command)
  useEffect(() => {
    const cleanup = window.fleet.pi.onOpen((payload) => {
      useWorkspaceStore.getState().addPiTab(payload.cwd);
    });
    return () => {
      cleanup();
    };
  }, []);

  // Open Pi plan document in modal via IPC (fleet pi plan_open / Pi extension bridge)
  useEffect(() => {
    const cleanup = window.fleet.pi.onPlanOpen((payload) => {
      setPlanModalQueue((queue) => [...queue, { ...payload, modalId: crypto.randomUUID() }]);
    });
    return () => {
      cleanup();
    };
  }, []);

  const activePlanModal = planModalQueue[0] ?? null;
  const closeActivePlanModal = useCallback(() => {
    setPlanModalQueue((queue) => queue.slice(1));
  }, []);

  // Live kanban updates: any task_event → refetch board + open task (150ms coalesced)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = window.fleet.kanban.onEvent(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const s = useKanbanStore.getState();
        void s.loadBoard();
        void s.refreshDetail();
      }, 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
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

  // Restore last active workspace on startup (or default), create a fresh tab if empty
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void window.fleet.layout.list().then(({ workspaces }) => {
      const lastWsId = localStorage.getItem('fleet:last-workspace-id');
      const targetWs =
        (lastWsId ? workspaces.find((w) => w.id === lastWsId) : null) ??
        workspaces.find((w) => w.id === 'default');
      const others = workspaces.filter((w) => w.id !== targetWs?.id);

      if (targetWs) {
        useWorkspaceStore.getState().loadWorkspace(targetWs);
        // If the restored workspace has no tabs, create a fresh one
        if (targetWs.tabs.length === 0) {
          addTab(undefined, window.fleet.homeDir);
          useWorkspaceStore.getState().reconcileToolTabs();
        }
      } else if (workspace.tabs.length === 0) {
        addTab(undefined, window.fleet.homeDir);
        useWorkspaceStore.getState().reconcileToolTabs();
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
        tabs: state.workspace.tabs
          .filter((tab) => tab.type !== 'settings')
          .map((tab) => ({
            ...tab,
            splitRoot: injectLiveCwd(tab.splitRoot)
          }))
      };
      void window.fleet.layout.save({ workspace: activeWithContent });

      // Save background workspaces
      for (const bgWs of state.backgroundWorkspaces.values()) {
        const bgWithContent = {
          ...bgWs,
          tabs: bgWs.tabs
            .filter((tab) => tab.type !== 'settings')
            .map((tab) => ({
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
      // Capture worktree path for delayed cleanup
      const worktreePath = lastClosedTab.tab.worktreePath;
      const worktreePathContext = lastClosedTab.tab.pathContext;
      undoTimerRef.current = setTimeout(() => {
        setShowUndoToast(false);
        killClosedTabPtys(paneIds);
        pendingKillRef.current = [];
        // Clean up worktree after undo window expires
        if (worktreePath) {
          void window.fleet.worktree.remove({ worktreePath, pathContext: worktreePathContext });
        }
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

  // Load workspace list when mini sidebar workspace popover opens
  useEffect(() => {
    if (!miniWsOpen) return;
    void window.fleet.layout.list().then(({ workspaces }) => {
      setMiniWsList(
        workspaces
          .filter((w) => w.id !== workspace.id)
          .map((w) => ({ id: w.id, label: w.label, tabCount: w.tabs.length }))
      );
    });
  }, [miniWsOpen, workspace.id]);

  const handleMiniWsSwitch = useCallback(async (wsId: string) => {
    setMiniWsOpen(false);
    const state = useWorkspaceStore.getState();
    await window.fleet.layout.save({
      workspace: {
        ...state.workspace,
        activeTabId: state.activeTabId ?? undefined,
        activePaneId: state.activePaneId ?? undefined,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: injectLiveCwd(tab.splitRoot)
        }))
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
    setTimeout(() => {
      const s = useWorkspaceStore.getState();
      if (s.workspace.tabs.length === 0) {
        s.addTab(undefined, window.fleet.homeDir);
      }
    }, 0);
  }, []);

  // Prevent stray file drops from navigating the renderer to a file:// URL.
  // Existing dropzones call preventDefault in their own handlers and are unaffected.
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

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

      // Skip tab close for panes being restarted (config change restart).
      // Consume the entry so the guard doesn't leak.
      if (restartingPanes.has(paneId)) {
        restartingPanes.delete(paneId);
        return;
      }

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

      // Background workspace tabs: close without undo toast (user isn't looking at them)
      if (isBackground) {
        state.closeTab(tab.id);
        return;
      }

      // Worktree tab: show confirmation dialog instead of closing immediately
      if (tab.worktreePath) {
        state.setWorktreeCloseConfirm({ tabId: tab.id, label: tab.label });
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

  const accentVars = getAccentCssVars(settings?.general.accentColor);
  const appThemeVars = useAppThemeVars(settings?.general.theme, settings?.general.terminalTheme);
  const themeVars = { ...accentVars, ...appThemeVars };

  // One global slideshow clock so every pane (including hidden background
  // workspaces) shows the same image and crossfades in sync.
  const slideshowFrame = useSlideshow(settings?.general.terminalBackground);

  return (
    <div
      className="flex flex-col h-screen w-screen bg-fleet-bg text-fleet-text overflow-hidden"
      style={themeVars}
    >
      {/* Top bar — drag region for window movement, houses OS window controls */}
      <div
        className="h-9 shrink-0 bg-fleet-bg flex items-center"
        style={{ WebkitAppRegion: 'drag' }}
      >
        <ShortcutsHint />
      </div>
      <div className="flex flex-1 min-h-0">
        {!sidebarCollapsed ? (
          <Sidebar
            updateReady={updateReady}
            onCollapse={() => setSidebarCollapsed(true)}
            onOpenToolsConfig={() => setToolsConfigOpen(true)}
          />
        ) : (
          <div
            className="flex flex-col items-center h-full w-11 bg-fleet-surface border-r border-fleet-border shrink-0 py-2 gap-1"
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            {/* Expand sidebar button */}
            <MiniSidebarTooltip label="Show sidebar">
              <button
                onClick={() => setSidebarCollapsed(false)}
                className="p-2 text-fleet-text-subtle hover:text-fleet-text-secondary hover:bg-fleet-surface-2 rounded transition-colors active:scale-90"
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
            </MiniSidebarTooltip>
            <div className="w-6 h-px bg-fleet-border my-0.5" />
            {/* File/terminal/image tab icons (excluding pinned + settings) */}
            {workspace.tabs
              .filter(
                (t) =>
                  t.type !== 'images' &&
                  t.type !== 'settings' &&
                  t.type !== 'annotate' &&
                  t.type !== 'kanban' &&
                  t.type !== 'sessions' &&
                  t.type !== 'chat'
              )
              .map((tab) => {
                const isActive = tab.id === activeTabId;
                return (
                  <MiniSidebarTooltip label={tab.label} key={tab.id}>
                    <button
                      onClick={() => setActiveTab(tab.id)}
                      className={`p-1 rounded transition-colors active:scale-90 ${
                        isActive
                          ? 'bg-fleet-surface-3 ring-1 ring-fleet-border-strong'
                          : 'hover:bg-fleet-surface-2'
                      }`}
                    >
                      {tab.type === 'file' || tab.type === 'pdf' ? (
                        <span className={isActive ? 'text-fleet-text' : 'text-fleet-text-subtle'}>
                          {getFileIcon(
                            collectPaneLeafs(tab.splitRoot)[0]?.filePath?.split('/').pop() ??
                              tab.label,
                            16
                          )}
                        </span>
                      ) : tab.type === 'image' ? (
                        <ImageIcon
                          size={16}
                          className={isActive ? 'text-fleet-text' : 'text-fleet-text-subtle'}
                        />
                      ) : (
                        <Terminal
                          size={16}
                          className={isActive ? 'text-fleet-text' : 'text-fleet-text-subtle'}
                        />
                      )}
                    </button>
                  </MiniSidebarTooltip>
                );
              })}
            <div className="flex-1" />
            {/* Pinned tools section (mirrors expanded sidebar: tools above workspaces) */}
            {workspace.tabs.some(
              (t) =>
                t.type === 'images' ||
                t.type === 'annotate' ||
                t.type === 'kanban' ||
                t.type === 'sessions' ||
                t.type === 'chat'
            ) && <div className="w-6 h-px bg-fleet-border my-0.5" />}
            {/* Kanban pinned icon */}
            {workspace.tabs
              .filter((t) => t.type === 'kanban')
              .map((tab) => {
                const isKanbanActive = tab.id === activeTabId;
                return (
                  <MiniSidebarTooltip label="Kanban" key={tab.id}>
                    <button
                      onClick={() => setActiveTab(tab.id)}
                      className={`p-1.5 rounded transition-colors active:scale-90 ${
                        isKanbanActive
                          ? 'bg-blue-900/40 ring-1 ring-blue-500/30'
                          : 'hover:bg-fleet-surface-2'
                      }`}
                    >
                      <KanbanSquare
                        size={16}
                        className={isKanbanActive ? 'text-blue-400' : 'text-blue-400/40'}
                      />
                    </button>
                  </MiniSidebarTooltip>
                );
              })}
            {/* Images pinned icon */}
            {workspace.tabs
              .filter((t) => t.type === 'images')
              .map((tab) => {
                const isImagesActive = tab.id === activeTabId;
                return (
                  <MiniSidebarTooltip label="Images" key={tab.id}>
                    <button
                      onClick={() => setActiveTab(tab.id)}
                      className={`p-1.5 rounded transition-colors active:scale-90 ${
                        isImagesActive
                          ? 'bg-purple-900/40 ring-1 ring-purple-500/30'
                          : 'hover:bg-fleet-surface-2'
                      }`}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={isImagesActive ? 'rgb(192,132,252)' : 'rgba(192,132,252,0.4)'}
                        strokeWidth="1.5"
                      >
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="M21 15l-5-5L5 21" />
                      </svg>
                    </button>
                  </MiniSidebarTooltip>
                );
              })}
            {/* Annotate pinned icon */}
            {workspace.tabs
              .filter((t) => t.type === 'annotate')
              .map((tab) => {
                const isAnnotateActive = tab.id === activeTabId;
                return (
                  <MiniSidebarTooltip label="Annotate" key={tab.id}>
                    <button
                      onClick={() => setActiveTab(tab.id)}
                      className={`p-1.5 rounded transition-colors active:scale-90 ${
                        isAnnotateActive
                          ? 'bg-cyan-900/40 ring-1 ring-cyan-500/30'
                          : 'hover:bg-fleet-surface-2'
                      }`}
                    >
                      <Crosshair
                        size={16}
                        className={isAnnotateActive ? 'text-cyan-400' : 'text-cyan-400/40'}
                      />
                    </button>
                  </MiniSidebarTooltip>
                );
              })}
            {/* Sessions pinned icon */}
            {workspace.tabs
              .filter((t) => t.type === 'sessions')
              .map((tab) => {
                const isSessionsActive = tab.id === activeTabId;
                return (
                  <MiniSidebarTooltip label="Sessions" key={tab.id}>
                    <button
                      onClick={() => setActiveTab(tab.id)}
                      className={`p-1.5 rounded transition-colors active:scale-90 ${
                        isSessionsActive
                          ? 'bg-blue-900/40 ring-1 ring-blue-500/30'
                          : 'hover:bg-fleet-surface-2'
                      }`}
                    >
                      <History
                        size={16}
                        className={isSessionsActive ? 'text-blue-400' : 'text-blue-400/40'}
                      />
                    </button>
                  </MiniSidebarTooltip>
                );
              })}
            {/* Chat pinned icon */}
            {workspace.tabs
              .filter((t) => t.type === 'chat')
              .map((tab) => {
                const isChatActive = tab.id === activeTabId;
                return (
                  <MiniSidebarTooltip label="Chat" key={tab.id}>
                    <button
                      onClick={() => setActiveTab(tab.id)}
                      className={`p-1.5 rounded transition-colors active:scale-90 ${
                        isChatActive
                          ? 'bg-emerald-900/40 ring-1 ring-emerald-500/30'
                          : 'hover:bg-fleet-surface-2'
                      }`}
                    >
                      <MessageSquare
                        size={16}
                        className={isChatActive ? 'text-emerald-400' : 'text-emerald-400/40'}
                      />
                    </button>
                  </MiniSidebarTooltip>
                );
              })}
            <div className="w-6 h-px bg-fleet-border my-0.5" />
            {/* Configure tools */}
            <MiniSidebarTooltip label="Configure tools">
              <button
                onClick={() => setToolsConfigOpen(true)}
                className="p-1.5 rounded text-fleet-text-subtle hover:text-fleet-text hover:bg-fleet-surface-2 transition-colors active:scale-90"
              >
                <SlidersHorizontal size={16} />
              </button>
            </MiniSidebarTooltip>
            {/* Workspace switcher popover */}
            <Popover.Root open={miniWsOpen} onOpenChange={setMiniWsOpen}>
              <MiniSidebarTooltip label={workspace.label}>
                <Popover.Trigger asChild>
                  <button className="p-2 text-fleet-text-subtle hover:text-fleet-text-secondary hover:bg-fleet-surface-2 rounded transition-colors active:scale-90">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <rect x="2" y="3" width="12" height="10" rx="1.5" />
                      <path d="M2 6h12" />
                      <path d="M5 3V1.5" />
                      <path d="M11 3V1.5" />
                    </svg>
                  </button>
                </Popover.Trigger>
              </MiniSidebarTooltip>
              <Popover.Portal>
                <Popover.Content
                  side="right"
                  sideOffset={8}
                  className={`min-w-[180px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg py-1 z-50 ${popperAnim}`}
                >
                  <div className="px-3 py-1.5 text-[10px] text-fleet-text-subtle uppercase tracking-wider">
                    Current: {workspace.label}
                  </div>
                  <div className="h-px bg-fleet-border-strong my-1" />
                  {miniWsList.length > 0 ? (
                    miniWsList.map((ws) => (
                      <button
                        key={ws.id}
                        className="w-full px-3 py-1.5 text-sm text-fleet-text-secondary hover:text-fleet-text hover:bg-fleet-surface-3 text-left flex items-center justify-between transition active:scale-[0.97]"
                        onClick={() => void handleMiniWsSwitch(ws.id)}
                      >
                        <span className="truncate">{ws.label}</span>
                        <span className="text-[10px] text-fleet-text-subtle ml-2">
                          {ws.tabCount} tab{ws.tabCount !== 1 ? 's' : ''}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-1.5 text-xs text-fleet-text-subtle italic">
                      No other workspaces
                    </div>
                  )}
                  <Popover.Arrow className="fill-fleet-surface-2" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            {/* Settings button */}
            {(() => {
              const isSettingsActive = workspace.tabs.some(
                (t) => t.type === 'settings' && t.id === activeTabId
              );
              return (
                <MiniSidebarTooltip label="Settings">
                  <button
                    onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-settings'))}
                    className={`p-2 rounded transition-colors active:scale-90 ${
                      isSettingsActive
                        ? 'text-fleet-text bg-fleet-surface-3 ring-1 ring-fleet-border-strong'
                        : 'text-fleet-text-subtle hover:text-fleet-text-secondary hover:bg-fleet-surface-2'
                    }`}
                  >
                    <Settings size={16} />
                  </button>
                </MiniSidebarTooltip>
              );
            })()}
          </div>
        )}
        <div className="flex-1 min-w-0 h-full flex flex-col">
          <main className="flex-1 min-w-0 relative overflow-hidden">
            {/* Active tab content — show empty state when no tab is selected */}
            {activeTabId ? (
              workspace.tabs.map((tab) => {
                const serializedPanes = restoredPanesRef.current.get(tab.id);
                return (
                  <div
                    key={tab.id}
                    className="h-full w-full"
                    style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
                  >
                    {tab.type === 'images' ? (
                      <ImageGallery />
                    ) : tab.type === 'annotate' ? (
                      <AnnotateTab />
                    ) : tab.type === 'settings' ? (
                      <SettingsTab />
                    ) : tab.type === 'pi' ? (
                      <PiTab
                        tab={tab}
                        isActive={tab.id === activeTabId}
                        fontFamily={settings?.general.fontFamily}
                        fontSize={settings?.general.fontSize}
                        terminalTheme={settings?.general.terminalTheme}
                      />
                    ) : tab.type === 'kanban' ? (
                      <KanbanBoard />
                    ) : tab.type === 'sessions' ? (
                      <SessionsTab />
                    ) : tab.type === 'chat' ? (
                      <ChatTab />
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
                        terminalTheme={settings?.general.terminalTheme}
                        terminalBackground={settings?.general.terminalBackground}
                        slideshowFrame={slideshowFrame}
                      />
                    )}
                  </div>
                );
              })
            ) : (
              <Dashboard
                recentFiles={recentFiles}
                recentFolders={recentFolders}
                onNewTerminal={() => addTab(undefined, '/')}
                onOpenFile={openFile}
                onOpenFolder={(folderPath) => addTab(undefined, folderPath)}
              />
            )}
            {/* Background workspace tabs (hidden, keep PTYs warm) */}
            {Array.from(backgroundWorkspaces.values()).flatMap((bgWs) =>
              bgWs.tabs.map((tab) => (
                <div key={tab.id} className="h-full w-full" style={{ display: 'none' }}>
                  <PaneGrid
                    root={tab.splitRoot}
                    activePaneId={null}
                    onPaneFocus={() => {}}
                    serializedPanes={undefined}
                    fontFamily={settings?.general.fontFamily}
                    fontSize={settings?.general.fontSize}
                    terminalTheme={settings?.general.terminalTheme}
                    terminalBackground={settings?.general.terminalBackground}
                    slideshowFrame={slideshowFrame}
                  />
                </div>
              ))
            )}
            {/* Undo close tab toast (NNG: undo > confirmation dialogs for divided-attention UX) */}
            {showUndoToast && lastClosedTab && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 bg-fleet-surface-2 border border-fleet-border-strong rounded-lg shadow-lg text-sm duration-150 animate-in fade-in-0 slide-in-from-bottom-2">
                <span className="text-fleet-text-secondary">
                  {lastClosedTab.tab.worktreePath ? 'Removing worktree' : 'Closed'} {'"'}
                  {lastClosedTab.tab.label}
                  {'"'}
                </span>
                <button
                  className="text-blue-400 hover:text-blue-300 font-medium transition active:scale-95"
                  onClick={handleUndo}
                >
                  Undo
                </button>
                <button
                  className="text-fleet-text-subtle hover:text-fleet-text-secondary transition active:scale-90"
                  onClick={() => {
                    setShowUndoToast(false);
                    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
                    if (lastClosedTab) {
                      killClosedTabPtys(collectPaneIds(lastClosedTab.tab.splitRoot));
                      pendingKillRef.current = [];
                      if (lastClosedTab.tab.worktreePath) {
                        void window.fleet.worktree.remove({
                          worktreePath: lastClosedTab.tab.worktreePath,
                          pathContext: lastClosedTab.tab.pathContext
                        });
                      }
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
      <ShortcutsPanel isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette isOpen={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      <GitChangesModal
        isOpen={gitChangesOpen}
        onClose={() => setGitChangesOpen(false)}
        cwd={focusedPaneCwd}
        pathContext={getPaneContextById(activePaneId)}
      />
      <QuickOpenOverlay
        isOpen={quickOpenOpen}
        onClose={() => setQuickOpenOpen(false)}
        rootDir={focusedPaneCwd}
      />
      <FileSearchOverlay isOpen={fileSearchOpen} onClose={() => setFileSearchOpen(false)} />
      <ClipboardHistoryOverlay
        isOpen={clipboardHistoryOpen}
        onClose={() => setClipboardHistoryOpen(false)}
      />
      <TelescopeModal
        isOpen={telescopeOpen}
        onClose={() => setTelescopeOpen(false)}
        cwd={focusedPaneCwd ?? window.fleet.homeDir}
      />
      <EnvSyncModal
        isOpen={envSyncOpen}
        onClose={() => setEnvSyncOpen(false)}
        cwd={focusedPaneCwd}
        pathContext={getPaneContextById(activePaneId)}
      />
      <EnvEditorModal
        isOpen={envEditorOpen}
        onClose={() => setEnvEditorOpen(false)}
        cwd={focusedPaneCwd}
        paneId={activePaneId}
        pathContext={activePathContext}
      />
      <AnnotateModal open={false} onClose={() => {}} />
      <ToolsConfigModal open={toolsConfigOpen} onClose={() => setToolsConfigOpen(false)} />
      <PiPlanModal
        plan={activePlanModal}
        contentKey={activePlanModal ? activePlanModal.modalId : undefined}
        onClose={closeActivePlanModal}
      />
      <ToastContainer />
    </div>
  );
}
