import { useCallback, useState, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dialog from '@radix-ui/react-dialog';
import { Settings, Terminal, ImageIcon } from 'lucide-react';
import { getFileIcon } from '../lib/file-icons';
import { TabItem } from './TabItem';
import { useWorkspaceStore, collectPaneIds, collectPaneLeafs } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';


import { useStarCommandStore } from '../store/star-command-store';
import admiralDefault from '../assets/admiral-default.png';
import admiralSpeaking from '../assets/admiral-speaking.png';
import admiralThinking from '../assets/admiral-thinking.png';
import admiralAlert from '../assets/admiral-alert.png';
import admiralStandby from '../assets/admiral-standby.png';
import { serializePane } from '../hooks/use-terminal';
import { injectLiveCwd } from '../lib/workspace-utils';
import { formatShortcut, getShortcut } from '../lib/shortcuts';
import { Avatar } from './star-command/Avatar';
import { getFileSave } from '../lib/file-save-registry';
import type { Workspace, PaneLeaf, Tab } from '../../../shared/types';

function getFirstDirtyPaneId(tab: Tab): string | null {
  function check(node: Tab['splitRoot']): string | null {
    if (node.type === 'leaf') return node.isDirty ? node.id : null;
    return check(node.children[0]) ?? check(node.children[1]);
  }
  return check(tab.splitRoot);
}

function getFirstLeaf(tab: Tab): PaneLeaf | null {
  function find(node: Tab['splitRoot']): PaneLeaf | null {
    if (node.type === 'leaf') return node;
    return find(node.children[0]) ?? find(node.children[1]);
  }
  return find(tab.splitRoot);
}

const AUTO_SAVE_DEBOUNCE_MS = 500;

const ADMIRAL_IMAGES: Record<string, string> = {
  default: admiralDefault,
  speaking: admiralSpeaking,
  thinking: admiralThinking,
  alert: admiralAlert,
  standby: admiralStandby
};

function StarCommandTabCard({
  isActive,
  onClick
}: {
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { admiralAvatarState, admiralStatus, crewList, unreadCount } = useStarCommandStore();

  const activeCrew = crewList.filter((c) => c.status === 'active').length;
  const errorCrew = crewList.filter((c) => c.status === 'error' || c.status === 'lost').length;
  const admiralSrc = ADMIRAL_IMAGES[admiralAvatarState] ?? ADMIRAL_IMAGES.default;

  const statusDotClass =
    admiralStatus === 'running'
      ? 'bg-green-400'
      : admiralStatus === 'starting'
        ? 'bg-yellow-400 animate-pulse'
        : 'bg-neutral-600';

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-md overflow-hidden relative transition-all"
      style={{
        background: isActive ? '#0a0a1a' : 'rgba(10,10,26,0.4)',
        border: isActive ? '1px solid rgba(20,184,166,0.35)' : '1px solid rgba(255,255,255,0.05)',
        boxShadow: isActive ? '0 0 10px rgba(20,184,166,0.15), inset 0 0 20px rgba(20,184,166,0.03)' : 'none'
      }}
    >
      {/* Scanline overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          backgroundImage: 'repeating-linear-gradient(transparent 0px, transparent 1px, rgba(0,0,0,0.12) 1px, rgba(0,0,0,0.12) 2px)',
          backgroundSize: '100% 2px'
        }}
      />

      <div className="relative z-20 flex items-center gap-2.5 px-2.5 py-2">
        {/* Admiral avatar */}
        <div className="flex-shrink-0 relative">
          <img
            src={admiralSrc}
            alt="Admiral"
            width={32}
            height={32}
            className="rounded-sm"
            style={{ imageRendering: 'pixelated' }}
          />
          {/* Status dot */}
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-neutral-900 ${statusDotClass}`}
          />
        </div>

        {/* Text content */}
        <div className="flex-1 min-w-0">
          <div
            className="font-mono uppercase tracking-widest leading-none mb-1"
            style={{
              fontSize: '9px',
              color: isActive ? 'rgb(45,212,191)' : 'rgba(45,212,191,0.5)'
            }}
          >
            Star Command
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-mono text-neutral-500">
              {activeCrew > 0 ? (
                <span className="text-green-400/70">{activeCrew} active</span>
              ) : (
                <span>no crew</span>
              )}
            </span>
            {errorCrew > 0 && (
              <span className="text-[9px] font-mono text-red-400/80">{errorCrew} err</span>
            )}
            {unreadCount > 0 && (
              <span
                className="text-[9px] font-mono font-semibold px-1 rounded-sm animate-pulse"
                style={{
                  background: 'rgba(20,184,166,0.2)',
                  color: 'rgb(45,212,191)'
                }}
              >
                {unreadCount}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({
  updateReady,
  onCollapse
}: {
  updateReady?: boolean;
  onCollapse?: () => void;
}): React.JSX.Element {
  const {
    workspace,
    activeTabId,
    activePaneId,
    setActiveTab,
    closeTab,
    renameTab,
    resetTabLabel,
    addTab,
    reorderTab,
    renameWorkspace,
    isDirty,
    markClean
  } = useWorkspaceStore(useShallow((s) => ({
    workspace: s.workspace,
    activeTabId: s.activeTabId,
    activePaneId: s.activePaneId,
    setActiveTab: s.setActiveTab,
    closeTab: s.closeTab,
    renameTab: s.renameTab,
    resetTabLabel: s.resetTabLabel,
    addTab: s.addTab,
    reorderTab: s.reorderTab,
    renameWorkspace: s.renameWorkspace,
    isDirty: s.isDirty,
    markClean: s.markClean
  })));
  const { getTabBadge } = useNotificationStore();

  // --- Drag-and-drop state ---
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    position: 'above' | 'below';
  } | null>(null);

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      if (dragIndex === null) return;
      const target = e.currentTarget;
      if (!(target instanceof HTMLElement)) return;
      const rect = target.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const position = e.clientY < midY ? 'above' : 'below';
      setDropTarget({ index, position });
    },
    [dragIndex]
  );

  const handleDrop = useCallback(() => {
    if (dragIndex === null || !dropTarget) return;
    const toIndex = dropTarget.position === 'below' ? dropTarget.index + 1 : dropTarget.index;
    // Adjust toIndex if dragging from before the drop point
    const adjustedTo = dragIndex < toIndex ? toIndex - 1 : toIndex;
    if (dragIndex !== adjustedTo) {
      reorderTab(dragIndex, adjustedTo);
    }
    setDragIndex(null);
    setDropTarget(null);
  }, [dragIndex, dropTarget, reorderTab]);

  // Clear drag state on drag end (even if drop didn't fire)
  useEffect(() => {
    const handleDragEnd = (): void => {
      setDragIndex(null);
      setDropTarget(null);
    };
    window.addEventListener('dragend', handleDragEnd);
    return () => window.removeEventListener('dragend', handleDragEnd);
  }, []);


  // --- Saved workspaces ---
  const [savedWorkspaces, setSavedWorkspaces] = useState<Array<{ id: string; label: string }>>([]);

  useEffect(() => {
    void window.fleet.layout.list().then((res) => {
      setSavedWorkspaces(res.workspaces.map((w) => ({ id: w.id, label: w.label })));
    });
  }, []);

  const doSwitchWorkspace = useCallback(async (wsId: string) => {
    // Flush current workspace with live CWDs BEFORE any async gap
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

    // Resolve target (in-memory or disk) and switch
    const freshState = useWorkspaceStore.getState();
    const inMemory = freshState.backgroundWorkspaces.get(wsId);
    if (inMemory) {
      freshState.switchWorkspace(inMemory);
    } else {
      const loaded = await window.fleet.layout.load(wsId);
      if (loaded) useWorkspaceStore.getState().switchWorkspace(loaded);
    }

    // Add a default tab if workspace is empty
    setTimeout(() => {
      const s = useWorkspaceStore.getState();
      if (s.workspace.tabs.length === 0) {
        s.addTab(undefined, window.fleet.homeDir);
      }
    }, 0);
  }, []);

  const handleSwitchWorkspace = useCallback(
    (wsId: string) => {
      void doSwitchWorkspace(wsId);
    },
    [doSwitchWorkspace]
  );

  // --- Auto-save with debounce ---
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isDirty) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const state = useWorkspaceStore.getState();
      const workspaceWithCwds = {
        ...state.workspace,
        activeTabId: state.activeTabId ?? undefined,
        activePaneId: state.activePaneId ?? undefined,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: injectLiveCwd(tab.splitRoot)
        }))
      };
      void window.fleet.layout
        .save({
          workspace: workspaceWithCwds
        })
        .then(() => {
          markClean();
          // Refresh saved workspaces list
          void window.fleet.layout.list().then((res) => {
            setSavedWorkspaces(res.workspaces.map((w) => ({ id: w.id, label: w.label })));
          });
        });
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [isDirty, workspace.tabs, workspace.label, markClean]);

  // --- New workspace creation ---
  const [showNewWsInput, setShowNewWsInput] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const newWsInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showNewWsInput && newWsInputRef.current) {
      newWsInputRef.current.focus();
    }
  }, [showNewWsInput]);

  const commitNewWorkspace = useCallback(async () => {
    const name = newWsName.trim();
    setShowNewWsInput(false);
    setNewWsName('');
    if (!name) return;

    // Flush current workspace to disk before switching away
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

    const newWs: Workspace = {
      id: crypto.randomUUID(),
      label: name,
      tabs: []
    };
    useWorkspaceStore.getState().switchWorkspace(newWs);

    // Refresh workspace list immediately (don't wait for autosave)
    void window.fleet.layout.list().then((res) => {
      setSavedWorkspaces(res.workspaces.map((w) => ({ id: w.id, label: w.label })));
    });

    setTimeout(() => {
      useWorkspaceStore.getState().addTab(undefined, window.fleet.homeDir);
    }, 0);
  }, [newWsName]);

  // --- Current workspace header rename ---
  const [isEditingWsLabel, setIsEditingWsLabel] = useState(false);
  const [wsLabelEdit, setWsLabelEdit] = useState('');
  const wsLabelInputRef = useRef<HTMLInputElement>(null);
  const wsLabelCancelledRef = useRef(false);

  useEffect(() => {
    if (isEditingWsLabel && wsLabelInputRef.current) {
      wsLabelInputRef.current.focus();
      wsLabelInputRef.current.select();
    }
  }, [isEditingWsLabel]);

  const commitWsLabelRename = useCallback(() => {
    if (wsLabelCancelledRef.current) {
      wsLabelCancelledRef.current = false;
      return;
    }
    const trimmed = wsLabelEdit.trim();
    if (trimmed && trimmed !== workspace.label) {
      renameWorkspace(trimmed);
    }
    setIsEditingWsLabel(false);
  }, [wsLabelEdit, workspace.label, renameWorkspace]);

  // --- Saved workspace rename ---
  const [renamingWsId, setRenamingWsId] = useState<string | null>(null);
  const [renamingWsValue, setRenamingWsValue] = useState('');
  const renamingWsInputRef = useRef<HTMLInputElement>(null);
  const savedWsRenamingRef = useRef(false);

  useEffect(() => {
    if (renamingWsId && renamingWsInputRef.current) {
      renamingWsInputRef.current.focus();
      renamingWsInputRef.current.select();
    }
  }, [renamingWsId]);

  const commitSavedWsRename = useCallback(async () => {
    if (savedWsRenamingRef.current) return;
    const id = renamingWsId;
    const trimmed = renamingWsValue.trim();
    setRenamingWsId(null);
    if (!id || !trimmed) return;
    savedWsRenamingRef.current = true;
    try {
      const full = await window.fleet.layout.load(id);
      if (!full) return;
      await window.fleet.layout.save({ workspace: { ...full, label: trimmed } });
      setSavedWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, label: trimmed } : w)));
    } finally {
      savedWsRenamingRef.current = false;
    }
  }, [renamingWsId, renamingWsValue]);

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // --- Tab list scroll state ---
  const tabListRef = useRef<HTMLDivElement>(null);
  const [hasScrollOverflow, setHasScrollOverflow] = useState(false);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (!activeTabId || !tabListRef.current) return;
    const el = tabListRef.current.querySelector(`[data-tab-id="${activeTabId}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeTabId]);

  // Track whether tab list overflows
  useEffect(() => {
    const el = tabListRef.current;
    if (!el) return;
    const check = (): void => {
      setHasScrollOverflow(
        el.scrollHeight > el.clientHeight && el.scrollTop + el.clientHeight < el.scrollHeight - 8
      );
    };
    check();
    el.addEventListener('scroll', check);
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      observer.disconnect();
    };
  }, []);

  const handleDeleteWorkspace = useCallback(async (wsId: string) => {
    await window.fleet.layout.delete(wsId);
    useWorkspaceStore.getState().removeBackgroundWorkspace(wsId);
    setSavedWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
    setDeleteConfirmId(null);
  }, []);

  // --- File close confirmation ---
  const [fileCloseConfirm, setFileCloseConfirm] = useState<{
    tabId: string;
    label: string;
    paneId: string;
  } | null>(null);
  const [fileSaving, setFileSaving] = useState(false);

  const doCloseTab = useCallback(
    (tabId: string) => {
      const tab = workspace.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const serializedPanes = new Map<string, string>();
      for (const paneId of collectPaneIds(tab.splitRoot)) {
        const content = serializePane(paneId);
        if (content) serializedPanes.set(paneId, content);
      }
      closeTab(tabId, serializedPanes);
    },
    [workspace.tabs, closeTab]
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = workspace.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      // File tabs: check for dirty panes before closing
      if (tab.type === 'file') {
        const dirtyPaneId = getFirstDirtyPaneId(tab);
        if (dirtyPaneId) {
          const leaf = getFirstLeaf(tab);
          const filename = leaf?.filePath?.split('/').pop() ?? tab.label;
          setFileCloseConfirm({ tabId, label: filename, paneId: dirtyPaneId });
          return;
        }
      }
      doCloseTab(tabId);
    },
    [workspace.tabs, doCloseTab]
  );

  return (
    <div className="flex flex-col h-full w-56 bg-neutral-900 border-r border-neutral-800">
      {/* Drag region + workspace label with add button */}
      <div className="px-3 pt-2 pb-3 flex items-center justify-between">
        <div style={{ WebkitAppRegion: 'no-drag' }} className="flex-1 min-w-0 mr-2">
          {isEditingWsLabel ? (
            <input
              ref={wsLabelInputRef}
              className="w-full bg-neutral-700 text-white text-xs font-semibold uppercase tracking-wider rounded px-1 py-0.5 outline-none border border-blue-500"
              value={wsLabelEdit}
              onChange={(e) => setWsLabelEdit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitWsLabelRename();
                if (e.key === 'Escape') {
                  wsLabelCancelledRef.current = true;
                  setIsEditingWsLabel(false);
                }
              }}
              onBlur={commitWsLabelRename}
            />
          ) : (
            <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
                <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider cursor-default select-none">
                  {workspace.label}
                </span>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="min-w-[140px] bg-neutral-800 border border-neutral-700 rounded-md shadow-lg p-1 text-sm text-neutral-200 z-50">
                  <ContextMenu.Item
                    className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-neutral-700 hover:bg-neutral-700"
                    onSelect={() => {
                      setWsLabelEdit(workspace.label);
                      setTimeout(() => setIsEditingWsLabel(true), 0);
                    }}
                  >
                    Rename
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          )}
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' }}>
          {/* Dirty state indicator */}
          {isDirty && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" title="Unsaved changes" />
          )}
          {/* Add tab button */}
          <button
            className="text-neutral-500 hover:text-white text-lg leading-none px-1 rounded hover:bg-neutral-800 transition-colors"
            onClick={() => addTab(undefined, window.fleet.homeDir)}
            title={`New Tab (${formatShortcut(getShortcut('new-tab')!)})`}
          >
            +
          </button>
          {onCollapse && (
            <button
              className="text-neutral-500 hover:text-white px-1 rounded hover:bg-neutral-800 transition-colors"
              onClick={onCollapse}
              title="Collapse sidebar"
            >
              <svg
                width="14"
                height="14"
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
          )}
        </div>
      </div>

      {/* Tab list */}
      <div className="flex-1 min-h-0 relative">
        <div ref={tabListRef} className="absolute inset-0 overflow-y-auto px-2 space-y-0.5 pb-2">
          {/* Star Command tab (pinned, not closeable) */}
          {workspace.tabs
            .filter((tab) => tab.type === 'star-command')
            .map((tab) => (
              <StarCommandTabCard
                key={tab.id}
                isActive={tab.id === activeTabId}
                onClick={() => setActiveTab(tab.id)}
              />
            ))}
          {workspace.tabs.filter((t) => t.type === 'star-command').length > 0 && (
            <div className="h-px bg-neutral-800 mx-1 my-1" />
          )}
          {/* Crew tabs (with sprite avatars) */}
          {workspace.tabs
            .filter((tab) => tab.type === 'crew')
            .map((tab) => {
              const paneIds = collectPaneIds(tab.splitRoot);
              const badge = getTabBadge(paneIds);
              return (
                <div
                  key={tab.id}
                  data-tab-id={tab.id}
                  className={`
                  group flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-md text-sm min-h-[44px] transition-colors
                  ${
                    tab.id === activeTabId
                      ? 'bg-neutral-700 text-white border-l-2 border-cyan-500'
                      : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 border-l-2 border-transparent'
                  }
                `}
                  onClick={() => {
                    setActiveTab(tab.id);
                    for (const paneId of paneIds) {
                      useNotificationStore.getState().clearPane(paneId);
                      window.fleet.notifications.paneFocused({ paneId });
                    }
                  }}
                >
                  <Avatar type="crew" variant={tab.avatarVariant} size={24} />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm leading-tight">{tab.label}</div>
                  </div>
                  {badge && tab.id !== activeTabId && (
                    <span
                      className={`rounded-full flex-shrink-0 w-2 h-2 ${
                        badge === 'error'
                          ? 'bg-red-400'
                          : badge === 'permission'
                            ? 'bg-amber-400 animate-pulse'
                            : 'bg-blue-400'
                      }`}
                    />
                  )}
                </div>
              );
            })}
          {workspace.tabs.filter((t) => t.type === 'crew').length > 0 && (
            <div className="h-px bg-neutral-800 mx-1 my-1" />
          )}
          {workspace.tabs
            .filter((t) => t.type !== 'star-command' && t.type !== 'crew')
            .map((tab, index) => {
              const paneIds = collectPaneIds(tab.splitRoot);
              const isFile = tab.type === 'file' || tab.type === 'image';

              // Derive CWD to display in TabItem
              let displayCwd: string;
              let drivingPaneId: string | undefined;
              if (isFile) {
                const leafs = collectPaneLeafs(tab.splitRoot);
                const filePath = leafs[0]?.filePath ?? '';
                displayCwd = filePath ? filePath.split('/').slice(0, -1).join('/') || '/' : '/';
              } else {
                drivingPaneId =
                  tab.id === activeTabId && activePaneId && paneIds.includes(activePaneId)
                    ? activePaneId
                    : paneIds[0];
                displayCwd = tab.cwd;
              }

              // Dirty label for file tabs
              const isFileDirty =
                isFile && collectPaneLeafs(tab.splitRoot).some((l) => l.isDirty === true);
              const displayLabel = isFile && isFileDirty ? tab.label + ' *' : tab.label;

              // Icon — use filePath basename for file tabs (label may be renamed)
              let icon: React.ReactNode;
              if (isFile) {
                const leafs2 = collectPaneLeafs(tab.splitRoot);
                const fileBasename = leafs2[0]?.filePath?.split('/').pop() ?? tab.label;
                icon =
                  tab.type === 'image' ? <ImageIcon size={14} /> : getFileIcon(fileBasename, 14);
              } else {
                icon = <Terminal size={14} />;
              }

              return (
                <TabItem
                  key={tab.id}
                  id={tab.id}
                  label={displayLabel}
                  labelIsCustom={tab.labelIsCustom ?? false}
                  cwd={displayCwd}
                  drivingPaneId={drivingPaneId}
                  isActive={tab.id === activeTabId}
                  badge={getTabBadge(paneIds)}
                  icon={icon}
                  disableReset={isFile}
                  index={index}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  isDragOver={dropTarget?.index === index ? dropTarget.position : null}
                  onClick={() => {
                    setActiveTab(tab.id);
                    if (!isFile) {
                      for (const paneId of paneIds) {
                        useNotificationStore.getState().clearPane(paneId);
                        window.fleet.notifications.paneFocused({ paneId });
                      }
                    }
                  }}
                  onClose={() => handleCloseTab(tab.id)}
                  onRename={(newLabel) => renameTab(tab.id, newLabel)}
                  onResetLabel={(liveCwd) => resetTabLabel(tab.id, liveCwd)}
                />
              );
            })}
        </div>
        {/* Scroll overflow shadow indicator */}
        {hasScrollOverflow && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-neutral-900/90 to-transparent z-10" />
        )}
      </div>

      {/* Bottom section: workspaces */}
      <div className="border-t border-neutral-800 px-2 py-2 space-y-0.5">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
            Workspaces
          </span>
          <button
            className="text-neutral-500 hover:text-white text-sm leading-none px-1 rounded hover:bg-neutral-800 transition-colors"
            onClick={() => {
              setShowNewWsInput(true);
              setNewWsName('');
            }}
            title="New Workspace"
          >
            +
          </button>
        </div>

        {/* Inline new workspace name input */}
        {showNewWsInput && (
          <div className="px-1">
            <input
              ref={newWsInputRef}
              type="text"
              value={newWsName}
              onChange={(e) => setNewWsName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitNewWorkspace();
                if (e.key === 'Escape') {
                  setShowNewWsInput(false);
                  setNewWsName('');
                }
              }}
              onBlur={() => {
                void commitNewWorkspace();
              }}
              placeholder="Workspace name..."
              className="w-full px-2 py-1 text-sm bg-neutral-800 text-white border border-neutral-600 rounded focus:border-blue-500 focus:outline-none"
            />
          </div>
        )}

        {/* Saved workspaces list */}
        {savedWorkspaces
          .filter((ws) => ws.id !== workspace.id)
          .map((ws) => (
            <div key={ws.id} className="relative">
              {deleteConfirmId === ws.id ? (
                <div className="flex flex-col gap-1 px-2 py-2 bg-neutral-800 rounded-md text-xs">
                  <span className="text-red-400">Delete this workspace?</span>
                  <div className="flex gap-2">
                    <button
                      className="px-2 py-0.5 bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                      onClick={() => {
                        void handleDeleteWorkspace(ws.id);
                      }}
                    >
                      Delete
                    </button>
                    <button
                      className="px-2 py-0.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded transition-colors"
                      onClick={() => setDeleteConfirmId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : renamingWsId === ws.id ? (
                <div className="px-1">
                  <input
                    ref={renamingWsInputRef}
                    type="text"
                    value={renamingWsValue}
                    onChange={(e) => setRenamingWsValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitSavedWsRename();
                      if (e.key === 'Escape') setRenamingWsId(null);
                    }}
                    onBlur={() => {
                      void commitSavedWsRename();
                    }}
                    className="w-full px-2 py-1 text-sm bg-neutral-800 text-white border border-neutral-600 rounded focus:border-blue-500 focus:outline-none"
                  />
                </div>
              ) : (
                <ContextMenu.Root>
                  <ContextMenu.Trigger asChild>
                    <button
                      className="w-full flex items-center justify-between px-2 py-1.5 text-sm text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-md transition-colors"
                      onClick={() => handleSwitchWorkspace(ws.id)}
                      title={`Switch to ${ws.label}`}
                    >
                      <span className="truncate">{ws.label}</span>
                      <span className="text-xs text-neutral-500 hover:text-blue-400 ml-1 flex-shrink-0">
                        Open
                      </span>
                    </button>
                  </ContextMenu.Trigger>
                  <ContextMenu.Portal>
                    <ContextMenu.Content className="min-w-[140px] bg-neutral-800 border border-neutral-700 rounded-md shadow-lg p-1 text-sm text-neutral-200 z-50">
                      <ContextMenu.Item
                        className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-neutral-700 hover:bg-neutral-700"
                        onSelect={() => {
                          setRenamingWsValue(ws.label);
                          setTimeout(() => setRenamingWsId(ws.id), 0);
                        }}
                      >
                        Rename
                      </ContextMenu.Item>
                      <ContextMenu.Separator className="my-1 h-px bg-neutral-700" />
                      <ContextMenu.Item
                        className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-red-900/50 hover:bg-red-900/50 text-red-400"
                        onSelect={() => setDeleteConfirmId(ws.id)}
                      >
                        Delete
                      </ContextMenu.Item>
                    </ContextMenu.Content>
                  </ContextMenu.Portal>
                </ContextMenu.Root>
              )}
            </div>
          ))}
      </div>

      {/* Settings + Update indicator */}
      <div className="border-t border-neutral-800 px-3 py-2 space-y-1">
        <button
          className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-md transition-colors"
          onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-settings'))}
          title="Settings (⌘,)"
        >
          <Settings size={14} />
          Settings
          {updateReady && (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          )}
        </button>
      </div>

      {/* File close confirmation dialog */}
      <Dialog.Root
        open={!!fileCloseConfirm}
        onOpenChange={(open) => {
          if (!open && !fileSaving) setFileCloseConfirm(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 z-50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-5 w-80 text-sm">
            <Dialog.Title className="text-base font-semibold text-white mb-1">
              Save changes to &ldquo;{fileCloseConfirm?.label}&rdquo;?
            </Dialog.Title>
            <Dialog.Description className="text-neutral-400 mb-5 text-xs">
              Your changes will be lost if you don&apos;t save.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                onClick={() => {
                  if (fileCloseConfirm) doCloseTab(fileCloseConfirm.tabId);
                  setFileCloseConfirm(null);
                }}
              >
                Don&apos;t Save
              </button>
              <button
                className="px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                onClick={() => setFileCloseConfirm(null)}
              >
                Cancel
              </button>
              <button
                disabled={fileSaving}
                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors font-medium"
                onClick={() => {
                  if (!fileCloseConfirm) return;
                  setFileSaving(true);
                  const saveFn = getFileSave(fileCloseConfirm.paneId);
                  if (saveFn) {
                    void saveFn().then(() => {
                      setFileSaving(false);
                      doCloseTab(fileCloseConfirm.tabId);
                      setFileCloseConfirm(null);
                    });
                  } else {
                    setFileSaving(false);
                    doCloseTab(fileCloseConfirm.tabId);
                    setFileCloseConfirm(null);
                  }
                }}
              >
                {fileSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
