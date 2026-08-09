import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Terminal,
  ImageIcon,
  Settings,
  Crosshair,
  History,
  SlidersHorizontal,
  Bot,
  Server
} from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Popover from '@radix-ui/react-popover';
import { getFileIcon } from './lib/file-icons';
import type { Tab } from '../../shared/types';
import { Sidebar } from './components/Sidebar';
import { TabStatusIndicator } from './components/TabStatusIndicator';
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
import { useNotificationStore } from './store/notification-store';
import { clearCreatedPty, restartingPanes, serializePane } from './hooks/use-terminal';
import { initCwdListener, useCwdStore } from './store/cwd-store';
import { initRemoteListener } from './store/remote-store';
import { initRemoteTransferListener } from './store/remote-ssh-store';
import { useSettingsStore } from './store/settings-store';
import { useShellProfilesStore } from './store/shell-profiles-store';
import { useHomesStore } from './store/homes-store';
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
import { AgentOverview } from './components/AgentOverview';
import { PeekPanel } from './components/PeekPanel';
import { EnvSyncModal } from './components/env-sync/EnvSyncModal';
import { EnvEditorModal } from './components/env-editor/EnvEditorModal';
import { NotesModal } from './components/notes/NotesModal';
import { ShellEnvModal } from './components/shell-env/ShellEnvModal';
import { AgentFolderDialog } from './components/agent/AgentFolderDialog';
import { AnnotateTab } from './components/AnnotateTab';
import { SessionsTab } from './components/sessions/SessionsTab';
import { AnnotateModal } from './components/AnnotateModal';
import { ToastContainer } from './components/ToastContainer';
import { getAccentCssVars } from './lib/theme';
import { tooltipAnim, popperAnim } from './lib/motion';
import { useAppThemeVars } from './hooks/use-app-theme';
import { useSlideshow } from './hooks/use-slideshow';
import { findPaneLocation } from './lib/palette-items';

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

/**
 * Section seam in the collapsed rail. Spans the full rail width so a group
 * boundary reads at a glance instead of dissolving into the background.
 */
function RailDivider(): React.JSX.Element {
  return <div className="w-full h-px bg-fleet-border-strong my-0.5" />;
}

/**
 * Corner status dot for a rail tab — the same signal the sidebar row shows next
 * to its label, anchored to the icon's top-right and ringed in the rail surface
 * so it reads as a badge rather than a smudge on the glyph beneath.
 *
 * Subscribes per tab: lifting the notification store into `App` would re-render
 * every pane on each activity tick.
 */
function MiniTabStatus({
  paneIds,
  isActive
}: {
  paneIds: string[];
  isActive: boolean;
}): React.JSX.Element | null {
  const badge = useNotificationStore((s) => s.getTabBadge(paneIds));
  const activity = useNotificationStore((s) => s.getTabActivity(paneIds));

  return (
    <TabStatusIndicator
      activity={activity}
      badge={badge}
      isActive={isActive}
      className="absolute -top-0.5 -right-0.5 ring-2 ring-fleet-surface"
    />
  );
}

/**
 * One tab button in the collapsed rail. Shared by the regular-tab run and the
 * pinned agent run so both draw the same icon, active ring, and tooltip.
 */
function MiniTabButton({
  tab,
  isActive,
  onClick
}: {
  tab: Tab;
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const tint = isActive ? 'text-fleet-text' : 'text-fleet-text-subtle';
  // Same icon vocabulary the expanded sidebar uses, so a tab keeps its glyph
  // when the sidebar collapses.
  const isFile =
    tab.type === 'file' || tab.type === 'image' || tab.type === 'markdown' || tab.type === 'pdf';

  let icon: React.ReactNode;
  if (tab.type === 'agent') {
    icon = <Bot size={16} className={tint} />;
  } else if (tab.type === 'ssh-browser') {
    icon = <Server size={16} className={tint} />;
  } else if (tab.type === 'image') {
    icon = <ImageIcon size={16} className={tint} />;
  } else if (isFile) {
    const leafs = collectPaneLeafs(tab.splitRoot);
    const basename = (leafs[0]?.remotePath ?? leafs[0]?.filePath)?.split('/').pop() ?? tab.label;
    icon = <span className={tint}>{getFileIcon(basename, 16)}</span>;
  } else {
    icon = <Terminal size={16} className={tint} />;
  }

  return (
    <MiniSidebarTooltip label={tab.label}>
      <button
        onClick={onClick}
        className={`relative p-1 rounded transition-colors active:scale-90 ${
          isActive
            ? 'bg-fleet-surface-3 ring-1 ring-fleet-border-strong'
            : 'hover:bg-fleet-surface-2'
        }`}
      >
        {icon}
        <MiniTabStatus paneIds={collectPaneIds(tab.splitRoot)} isActive={isActive} />
      </button>
    </MiniSidebarTooltip>
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
    openFile,
    openAgentPane
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
      openFile: s.openFile,
      openAgentPane: s.openAgentPane
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
  const [agentOverviewOpen, setAgentOverviewOpen] = useState(false);
  const [peekPaneId, setPeekPaneId] = useState<string | null>(null);
  const [envSyncOpen, setEnvSyncOpen] = useState(false);
  const [envEditorOpen, setEnvEditorOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [shellEnvOpen, setShellEnvOpen] = useState(false);
  const [agentFolderOpen, setAgentFolderOpen] = useState(false);
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

  // Subscribe to SSH file transfer progress
  useEffect(() => {
    return initRemoteTransferListener();
  }, []);

  // Listen for focus-pane from main process (copilot "Go to Terminal", OS notifications)
  useEffect(() => {
    return window.fleet.notifications.onFocusPane(({ paneId }) => {
      const state = useWorkspaceStore.getState();
      // Find which tab contains this pane
      const tab = state.workspace.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId));
      if (tab) {
        useWorkspaceStore.setState({ activeTabId: tab.id, activePaneId: paneId });
        // Being on the right tab is not being in front of the thing that asked:
        // a terminal still has to take the cursor, and an agent pane parked on
        // its Settings view would show a settings screen to someone who came
        // here to answer a question.
        document.dispatchEvent(new CustomEvent('fleet:refocus-pane', { detail: { paneId } }));
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

  // Peek at the first pane that needs input, without switching to it
  useEffect(() => {
    const handler = (): void => {
      const activities = useNotificationStore.getState().activities;
      for (const [paneId, rec] of activities) {
        if (rec.state === 'needs_me') {
          setPeekPaneId(paneId);
          break;
        }
      }
    };
    document.addEventListener('fleet:peek-needy-agent', handler);
    return () => document.removeEventListener('fleet:peek-needy-agent', handler);
  }, []);

  // Git changes modal toggle
  useEffect(() => {
    const handler = (): void => setGitChangesOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-git-changes', handler);
    return () => document.removeEventListener('fleet:toggle-git-changes', handler);
  }, []);

  // Agent overview toggle
  useEffect(() => {
    const handler = (): void => setAgentOverviewOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-agent-overview', handler);
    return () => document.removeEventListener('fleet:toggle-agent-overview', handler);
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

  // Project notes modal toggle
  useEffect(() => {
    const handler = (): void => setNotesOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-notes', handler);
    return () => document.removeEventListener('fleet:toggle-notes', handler);
  }, []);

  // Shell environment modal toggle
  useEffect(() => {
    const handler = (): void => setShellEnvOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-shell-env', handler);
    return () => document.removeEventListener('fleet:toggle-shell-env', handler);
  }, []);

  // New agent: pick the folder first, then open the pane in it
  useEffect(() => {
    const handler = (): void => setAgentFolderOpen(true);
    document.addEventListener('fleet:new-agent', handler);
    return () => document.removeEventListener('fleet:new-agent', handler);
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

  // The collapsed rail splits its icons the same way the expanded sidebar does:
  // agents are a pinned run of their own rather than mixed into the tab list.
  const miniRailTabs = workspace.tabs.filter(
    (t) =>
      t.type !== 'settings' && t.type !== 'annotate' && t.type !== 'sessions' && t.type !== 'agent'
  );
  const miniRailAgentTabs = workspace.tabs.filter((t) => t.type === 'agent');

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
            <RailDivider />
            {/* File/terminal/image tab icons (agents and pinned tools run below) */}
            {miniRailTabs.map((tab) => (
              <MiniTabButton
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                onClick={() => setActiveTab(tab.id)}
              />
            ))}
            <div className="flex-1" />
            {/* Pinned agents section (mirrors expanded sidebar: agents above tools) */}
            {miniRailAgentTabs.length > 0 && (
              <>
                <RailDivider />
                {miniRailAgentTabs.map((tab) => (
                  <MiniTabButton
                    key={tab.id}
                    tab={tab}
                    isActive={tab.id === activeTabId}
                    onClick={() => setActiveTab(tab.id)}
                  />
                ))}
              </>
            )}
            {/* Pinned tools section (mirrors expanded sidebar: tools above workspaces) */}
            {workspace.tabs.some((t) => t.type === 'annotate' || t.type === 'sessions') && (
              <RailDivider />
            )}
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
            <RailDivider />
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
                    {tab.type === 'annotate' ? (
                      <AnnotateTab />
                    ) : tab.type === 'settings' ? (
                      <SettingsTab />
                    ) : tab.type === 'sessions' ? (
                      <SessionsTab />
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
      <AgentOverview
        isOpen={agentOverviewOpen}
        onClose={() => setAgentOverviewOpen(false)}
        onPeek={setPeekPaneId}
      />
      <PeekPanel paneId={peekPaneId} onClose={() => setPeekPaneId(null)} />
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
      <NotesModal
        isOpen={notesOpen}
        onClose={() => setNotesOpen(false)}
        cwd={focusedPaneCwd}
        paneId={activePaneId}
        pathContext={activePathContext}
      />
      <ShellEnvModal
        isOpen={shellEnvOpen}
        onClose={() => setShellEnvOpen(false)}
        paneId={activePaneId}
      />
      <AgentFolderDialog
        open={agentFolderOpen}
        onCancel={() => setAgentFolderOpen(false)}
        onConfirm={(folderPath, worktree) => {
          setAgentFolderOpen(false);
          openAgentPane(folderPath, worktree);
        }}
      />
      <AnnotateModal open={false} onClose={() => {}} />
      <ToolsConfigModal open={toolsConfigOpen} onClose={() => setToolsConfigOpen(false)} />
      <ToastContainer />
    </div>
  );
}
