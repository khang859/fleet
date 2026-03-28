import { useCallback, useState, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dialog from '@radix-ui/react-dialog';
import { Settings, Terminal, ImageIcon, ChevronRight } from 'lucide-react';
import { getFileIcon } from '../lib/file-icons';
import { TabItem } from './TabItem';
import { createLogger } from '../logger';

const logDnd = createLogger('sidebar:dnd');
import { useWorkspaceStore, collectPaneIds, collectPaneLeafs } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';
import { useCwdStore } from '../store/cwd-store';

import { useStarCommandStore } from '../store/star-command-store';
import { useImageStore } from '../store/image-store';
import admiralDefault from '../assets/admiral-default.png';
import admiralSpeaking from '../assets/admiral-speaking.png';
import admiralThinking from '../assets/admiral-thinking.png';
import admiralAlert from '../assets/admiral-alert.png';
import admiralStandby from '../assets/admiral-standby.png';
import { serializePane } from '../hooks/use-terminal';
import { injectLiveCwd, getFirstPaneLiveCwd } from '../lib/workspace-utils';
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

function GroupHeader({
  label,
  tabCount,
  isCollapsed,
  onToggle,
  onAddWorktree,
  onRename,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
}: {
  label: string;
  tabCount: number;
  isCollapsed: boolean;
  onToggle: () => void;
  onAddWorktree: () => void;
  onRename: (newLabel: string) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  isDragOver: 'above' | 'below' | null;
}): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== label) {
      onRename(trimmed);
    }
    setIsEditing(false);
  }, [editValue, label, onRename]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="group/header flex items-center gap-1.5 px-2 py-2 mt-2 cursor-pointer rounded-md text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50 transition-colors relative select-none uppercase tracking-wider"
          onClick={onToggle}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', 'group');
            onDragStart();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            onDragOver(e);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDrop();
          }}
        >
          {isDragOver === 'above' && (
            <div className="absolute top-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full -translate-y-0.5" />
          )}
          {isDragOver === 'below' && (
            <div className="absolute bottom-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full translate-y-0.5" />
          )}
          <ChevronRight
            size={12}
            className={`transition-transform flex-shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
          />
          {isEditing ? (
            <input
              ref={inputRef}
              className="flex-1 bg-neutral-600 text-white text-xs rounded px-1 py-0 outline-none border border-blue-500 min-w-0 uppercase tracking-wider"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setIsEditing(false);
              }}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className="truncate font-semibold"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditValue(label);
                setIsEditing(true);
              }}
            >
              {label}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {isCollapsed && (
              <span className="text-[10px] text-neutral-600">{tabCount} tabs</span>
            )}
            <button
              className="opacity-60 group-hover/header:opacity-100 text-neutral-400 hover:text-white w-5 h-5 flex items-center justify-center text-sm rounded border border-neutral-600 hover:border-neutral-500 hover:bg-neutral-700 transition-all"
              onClick={(e) => {
                e.stopPropagation();
                onAddWorktree();
              }}
              title="Add worktree"
            >
              +
            </button>
          </span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[140px] bg-neutral-800 border border-neutral-700 rounded-md shadow-lg p-1 text-sm text-neutral-200 z-50">
          <ContextMenu.Item
            className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-neutral-700 hover:bg-neutral-700"
            onSelect={() => {
              setEditValue(label);
              setTimeout(() => setIsEditing(true), 0);
            }}
          >
            Rename
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

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
        boxShadow: isActive
          ? '0 0 10px rgba(20,184,166,0.15), inset 0 0 20px rgba(20,184,166,0.03)'
          : 'none'
      }}
    >
      {/* Scanline overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          backgroundImage:
            'repeating-linear-gradient(transparent 0px, transparent 1px, rgba(0,0,0,0.12) 1px, rgba(0,0,0,0.12) 2px)',
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

function ImagesTabCard({
  isActive,
  onClick
}: {
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { generations, isLoaded, loadGenerations } = useImageStore();
  const [thumbSrc, setThumbSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) void loadGenerations();
  }, [isLoaded, loadGenerations]);

  // Subscribe to live updates
  useEffect(() => {
    const cleanup = window.fleet.images.onChanged(() => {
      void loadGenerations();
    });
    return cleanup;
  }, [loadGenerations]);

  // Load thumbnail of most recent completed image
  const lastCompleted = generations.find(
    (g) => g.status === 'completed' && g.images.some((img) => img.filename)
  );
  const thumbFile = lastCompleted?.images.find((img) => img.filename);

  useEffect(() => {
    if (!lastCompleted || !thumbFile?.filename) {
      setThumbSrc(null);
      return;
    }
    const filePath = `${window.fleet.homeDir}/.fleet/images/generations/${lastCompleted.id}/${thumbFile.filename}`;
    setThumbSrc(`fleet-image://${filePath}`);
  }, [lastCompleted?.id, thumbFile?.filename]);

  const inProgress = generations.filter(
    (g) => g.status === 'queued' || g.status === 'processing'
  ).length;
  const totalImages = generations.length;

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-md overflow-hidden relative transition-all"
      style={{
        background: isActive ? '#0d0a1a' : 'rgba(13,10,26,0.4)',
        border: isActive ? '1px solid rgba(168,85,247,0.35)' : '1px solid rgba(255,255,255,0.05)',
        boxShadow: isActive
          ? '0 0 10px rgba(168,85,247,0.15), inset 0 0 20px rgba(168,85,247,0.03)'
          : 'none'
      }}
    >
      {/* Subtle noise overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-10 opacity-[0.03]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(transparent 0px, transparent 1px, rgba(255,255,255,0.15) 1px, rgba(255,255,255,0.15) 2px)',
          backgroundSize: '100% 2px'
        }}
      />

      <div className="relative z-20 flex items-center gap-2.5 px-2.5 py-2">
        {/* Thumbnail or icon */}
        <div className="flex-shrink-0 w-8 h-8 rounded-sm overflow-hidden bg-neutral-800/50 flex items-center justify-center">
          {thumbSrc ? (
            <img src={thumbSrc} alt="" className="w-full h-full object-cover" />
          ) : (
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke={isActive ? 'rgb(192,132,252)' : 'rgba(192,132,252,0.4)'}
              strokeWidth="1.5"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          )}
          {inProgress > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500/30 overflow-hidden">
              <div className="h-full bg-purple-400 animate-pulse" style={{ width: '60%' }} />
            </div>
          )}
        </div>

        {/* Text content */}
        <div className="flex-1 min-w-0">
          <div
            className="font-mono uppercase tracking-widest leading-none mb-1"
            style={{
              fontSize: '9px',
              color: isActive ? 'rgb(192,132,252)' : 'rgba(192,132,252,0.5)'
            }}
          >
            Images
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-mono text-neutral-500">
              {totalImages > 0 ? (
                <span className="text-purple-300/70">{totalImages} generated</span>
              ) : (
                <span>none yet</span>
              )}
            </span>
            {inProgress > 0 && (
              <span
                className="text-[9px] font-mono font-semibold px-1 rounded-sm animate-pulse"
                style={{
                  background: 'rgba(168,85,247,0.2)',
                  color: 'rgb(192,132,252)'
                }}
              >
                {inProgress}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OffScreenBadgeSummary({
  direction,
  count,
  label,
}: {
  direction: 'above' | 'below';
  count: number;
  label: string;
}): React.JSX.Element | null {
  if (count === 0) return null;
  const arrow = direction === 'above' ? '\u2191' : '\u2193';
  return (
    <div className="px-3 py-0.5 text-[10px] text-neutral-500 text-center">
      {arrow} {count} {label}
    </div>
  );
}

export function Sidebar({
  updateReady,
  onCollapse
}: {
  updateReady?: boolean;
  onCollapse: () => void;
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
    markClean,
    collapsedGroups,
    toggleGroupCollapsed,
    createWorktreeGroup,
    closeWorktreeTab,
    renameWorktreeGroup,
  } = useWorkspaceStore(
    useShallow((s) => ({
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
      markClean: s.markClean,
      collapsedGroups: s.collapsedGroups,
      toggleGroupCollapsed: s.toggleGroupCollapsed,
      createWorktreeGroup: s.createWorktreeGroup,
      closeWorktreeTab: s.closeWorktreeTab,
      renameWorktreeGroup: s.renameWorktreeGroup,
    }))
  );
  const { getTabBadge } = useNotificationStore();

  // --- Drag-and-drop state ---
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    position: 'above' | 'below';
  } | null>(null);

  // Map tab ID to its real index in workspace.tabs (not the filtered subset index)
  const realIndex = useCallback(
    (tabId: string) => workspace.tabs.findIndex((t) => t.id === tabId),
    [workspace.tabs]
  );

  const handleDragStart = useCallback((index: number) => {
    logDnd.debug('dragStart', { index, tabId: workspace.tabs[index]?.id });
    setDragIndex(index);
  }, [workspace.tabs]);

  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      if (dragIndex === null) return;
      const target = e.currentTarget;
      if (!(target instanceof HTMLElement)) return;
      const rect = target.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const position = e.clientY < midY ? 'above' : 'below';
      logDnd.debug('dragOver', { dragIndex, targetIndex: index, position, clientY: e.clientY, midY: Math.round(midY) });
      setDropTarget({ index, position });
    },
    [dragIndex]
  );

  const handleDrop = useCallback(() => {
    if (dragIndex === null || !dropTarget) {
      logDnd.debug('drop cancelled', { dragIndex, dropTarget });
      return;
    }
    const toIndex = dropTarget.position === 'below' ? dropTarget.index + 1 : dropTarget.index;
    // Adjust toIndex if dragging from before the drop point
    const adjustedTo = dragIndex < toIndex ? toIndex - 1 : toIndex;
    logDnd.debug('drop', { dragIndex, dropTarget, rawToIndex: toIndex, adjustedTo, willReorder: dragIndex !== adjustedTo });
    if (dragIndex !== adjustedTo) {
      reorderTab(dragIndex, adjustedTo);
    }
    setDragIndex(null);
    setDropTarget(null);
  }, [dragIndex, dropTarget, reorderTab]);

  // --- Worktree creation ---
  const handleCreateWorktree = useCallback(
    async (tabId: string, cwd: string) => {
      try {
        const result = await window.fleet.worktree.create({ repoPath: cwd });
        createWorktreeGroup(tabId, result.worktreePath, result.branchName, cwd);
      } catch (err) {
        console.error('Failed to create worktree:', err);
      }
    },
    [createWorktreeGroup]
  );

  // Track which tabs are in git repos (for showing "Create Worktree" in context menu)
  // Uses live CWD so the option appears even if the user cd'd into a repo after opening the tab
  const liveCwds = useCwdStore((s) => s.cwds);
  const [gitRepoTabs, setGitRepoTabs] = useState<Set<string>>(new Set());

  useEffect(() => {
    const checkGitRepos = async (): Promise<void> => {
      const newSet = new Set<string>();
      for (const tab of workspace.tabs) {
        if (tab.type && tab.type !== 'terminal') continue;
        const firstPaneId = collectPaneIds(tab.splitRoot)[0];
        const cwd = (firstPaneId ? liveCwds.get(firstPaneId) : undefined) ?? tab.cwd;
        try {
          const result = await window.fleet.git.isRepo(cwd);
          if (result.isRepo) newSet.add(tab.id);
        } catch {
          // ignore
        }
      }
      setGitRepoTabs(newSet);
    };
    void checkGitRepos();
  }, [workspace.tabs.length, liveCwds]);

  // Clear drag state on drag end (even if drop didn't fire)
  useEffect(() => {
    const handleDragEnd = (): void => {
      logDnd.debug('dragEnd', { hadDragIndex: dragIndex !== null });
      setDragIndex(null);
      setDropTarget(null);
    };
    window.addEventListener('dragend', handleDragEnd);
    return () => window.removeEventListener('dragend', handleDragEnd);
  }, [dragIndex]);

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
        collapsedGroups: Array.from(state.collapsedGroups),
        tabs: state.workspace.tabs
          .filter((tab) => tab.type !== 'settings')
          .map((tab) => {
            const liveCwd = getFirstPaneLiveCwd(tab.splitRoot);
            return {
              ...tab,
              cwd: liveCwd ?? tab.cwd,
              splitRoot: injectLiveCwd(tab.splitRoot),
            };
          })
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
        collapsedGroups: Array.from(state.collapsedGroups),
        tabs: state.workspace.tabs
          .filter((tab) => tab.type !== 'settings')
          .map((tab) => {
            const liveCwd = getFirstPaneLiveCwd(tab.splitRoot);
            return {
              ...tab,
              cwd: liveCwd ?? tab.cwd,
              splitRoot: injectLiveCwd(tab.splitRoot),
            };
          })
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
        collapsedGroups: Array.from(state.collapsedGroups),
        tabs: state.workspace.tabs
          .filter((tab) => tab.type !== 'settings')
          .map((tab) => {
            const liveCwd = getFirstPaneLiveCwd(tab.splitRoot);
            return {
              ...tab,
              cwd: liveCwd ?? tab.cwd,
              splitRoot: injectLiveCwd(tab.splitRoot),
            };
          })
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

  // Track off-screen tabs with badges
  const [offScreenCounts, setOffScreenCounts] = useState({ above: 0, below: 0 });

  useEffect(() => {
    const container = tabListRef.current;
    if (!container) return;

    const countOffScreen = (): void => {
      const tabElements = container.querySelectorAll('[data-tab-id]');
      let above = 0;
      let below = 0;
      const containerRect = container.getBoundingClientRect();

      tabElements.forEach((el) => {
        const hasBadge = el.querySelector('[aria-label*="notification"]');
        if (!hasBadge) return;
        const rect = el.getBoundingClientRect();
        if (rect.bottom < containerRect.top) above++;
        else if (rect.top > containerRect.bottom) below++;
      });

      setOffScreenCounts({ above, below });
    };

    const observer = new IntersectionObserver(countOffScreen, {
      root: container,
      threshold: 0,
    });

    const tabElements = container.querySelectorAll('[data-tab-id]');
    tabElements.forEach((el) => observer.observe(el));

    // Also recount on scroll
    container.addEventListener('scroll', countOffScreen);

    return () => {
      observer.disconnect();
      container.removeEventListener('scroll', countOffScreen);
    };
  }, [workspace.tabs.length]);

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

      // Any tab in a worktree group: clean up worktree if it has one, then remove from group
      if (tab.groupId) {
        if (tab.worktreePath) {
          void window.fleet.worktree.remove({ worktreePath: tab.worktreePath });
        }
        closeWorktreeTab(tabId);
        return;
      }

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
    [workspace.tabs, doCloseTab, closeWorktreeTab]
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
        </div>
      </div>

      {/* Tab list */}
      <div className="flex-1 min-h-0 relative flex flex-col">
        <OffScreenBadgeSummary direction="above" count={offScreenCounts.above} label="need attention" />
        <div
          ref={tabListRef}
          className="flex-1 min-h-0 overflow-y-auto px-2 space-y-0.5 pb-2"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop();
          }}
        >
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
          {/* Images tab (pinned, not closeable) */}
          {workspace.tabs
            .filter((tab) => tab.type === 'images')
            .map((tab) => (
              <ImagesTabCard
                key={tab.id}
                isActive={tab.id === activeTabId}
                onClick={() => setActiveTab(tab.id)}
              />
            ))}
          {workspace.tabs.filter((t) => t.type === 'images').length > 0 && (
            <div className="h-px bg-neutral-800 mx-1 my-1" />
          )}
          {/* Crew tabs (with sprite avatars) */}
          {workspace.tabs
            .filter((tab) => tab.type === 'crew')
            .map((tab) => {
              const paneIds = collectPaneIds(tab.splitRoot);
              const idx = realIndex(tab.id);
              return (
                <TabItem
                  key={tab.id}
                  id={tab.id}
                  label={tab.label}
                  labelIsCustom={tab.labelIsCustom ?? false}
                  cwd={tab.cwd}
                  isActive={tab.id === activeTabId}
                  badge={getTabBadge(paneIds)}
                  icon={<Avatar type="crew" variant={tab.avatarVariant} size={24} />}
                  activeBorderColor="border-cyan-500"
                  disableReset
                  index={idx}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  isDragOver={dropTarget?.index === idx ? dropTarget.position : null}
                  onClick={() => {
                    setActiveTab(tab.id);
                    for (const paneId of paneIds) {
                      useNotificationStore.getState().clearPane(paneId);
                      window.fleet.notifications.paneFocused({ paneId });
                    }
                  }}
                  onClose={() => handleCloseTab(tab.id)}
                  onRename={(newLabel) => renameTab(tab.id, newLabel)}
                  onResetLabel={(liveCwd) => resetTabLabel(tab.id, liveCwd)}
                />
              );
            })}
          {workspace.tabs.filter((t) => t.type === 'crew').length > 0 && (
            <div className="h-px bg-neutral-800 mx-1 my-1" />
          )}
          {(() => {
            const regularTabs = workspace.tabs.filter(
              (t) =>
                t.type !== 'star-command' &&
                t.type !== 'crew' &&
                t.type !== 'images' &&
                t.type !== 'settings'
            );

            const rendered: React.ReactNode[] = [];
            const seenGroups = new Set<string>();

            for (const tab of regularTabs) {
              // If tab is in a group, render group header first (once)
              if (tab.groupId && !seenGroups.has(tab.groupId)) {
                seenGroups.add(tab.groupId);
                const groupTabs = regularTabs.filter((t) => t.groupId === tab.groupId);
                const parentTab = groupTabs.find((t) => t.groupRole === 'parent');
                const isCollapsed = collapsedGroups.has(tab.groupId);
                const groupId = tab.groupId;
                const firstTabIdx = realIndex(groupTabs[0].id);

                rendered.push(
                  <GroupHeader
                    key={`group-${groupId}`}
                    label={groupTabs[0].groupLabel ?? parentTab?.label ?? 'Worktree Group'}
                    tabCount={groupTabs.length}
                    isCollapsed={isCollapsed}
                    onToggle={() => toggleGroupCollapsed(groupId)}
                    onRename={(newLabel) => renameWorktreeGroup(groupId, newLabel)}
                    onAddWorktree={() => {
                      // Use any tab in the group to find the repo
                      const anyTab = groupTabs[0];
                      const firstPane = collectPaneIds(anyTab.splitRoot)[0];
                      const cwd = (firstPane ? liveCwds.get(firstPane) : undefined) ?? anyTab.cwd;
                      void handleCreateWorktree(anyTab.id, cwd);
                    }}
                    onDragStart={() => handleDragStart(firstTabIdx)}
                    onDragOver={(e) => handleDragOver(e, firstTabIdx)}
                    onDrop={() => handleDrop()}
                    isDragOver={
                      dropTarget?.index === firstTabIdx
                        ? dropTarget.position
                        : null
                    }
                  />
                );
              }

              // Skip tabs in collapsed groups
              if (tab.groupId && collapsedGroups.has(tab.groupId)) continue;

              const paneIds = collectPaneIds(tab.splitRoot);
              const isFile = tab.type === 'file' || tab.type === 'image';
              const idx = realIndex(tab.id);

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

              const isFileDirty =
                isFile && collectPaneLeafs(tab.splitRoot).some((l) => l.isDirty === true);
              const displayLabel = isFile && isFileDirty ? tab.label + ' *' : tab.label;

              let icon: React.ReactNode;
              if (isFile) {
                const leafs2 = collectPaneLeafs(tab.splitRoot);
                const fileBasename = leafs2[0]?.filePath?.split('/').pop() ?? tab.label;
                icon =
                  tab.type === 'image' ? <ImageIcon size={14} /> : getFileIcon(fileBasename, 14);
              } else {
                icon = <Terminal size={14} />;
              }

              rendered.push(
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
                  index={idx}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  isDragOver={dropTarget?.index === idx ? dropTarget.position : null}
                  indentLevel={tab.groupId ? 1 : 0}
                  worktreeBranch={tab.worktreeBranch}
                  isWorktreeChild={tab.groupRole === 'worktree'}
                  onCreateWorktree={
                    !isFile && gitRepoTabs.has(tab.id) && !tab.worktreePath && !tab.groupId
                      ? () => {
                          const firstPane = collectPaneIds(tab.splitRoot)[0];
                          const liveCwd = firstPane ? liveCwds.get(firstPane) : undefined;
                          void handleCreateWorktree(tab.id, liveCwd ?? tab.cwd);
                        }
                      : undefined
                  }
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
            }

            return rendered;
          })()}
        </div>
        {/* Scroll overflow shadow indicator */}
        {hasScrollOverflow && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-neutral-900/90 to-transparent z-10" />
        )}
        <OffScreenBadgeSummary direction="below" count={offScreenCounts.below} label="need attention" />
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
        {(() => {
          const isSettingsActive = workspace.tabs.some(
            (t) => t.type === 'settings' && t.id === activeTabId
          );
          return (
            <button
              className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md transition-colors ${
                isSettingsActive
                  ? 'text-white bg-neutral-700 ring-1 ring-neutral-600'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
              }`}
              onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-settings'))}
              title="Settings (⌘,)"
            >
              <Settings size={14} />
              Settings
              {updateReady && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              )}
            </button>
          );
        })()}
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
