import { useCallback, useState, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Settings,
  Terminal,
  ImageIcon,
  ChevronRight,
  Bot,
  SlidersHorizontal,
  Server
} from 'lucide-react';
import { getFileIcon } from '../lib/file-icons';
import { TabItem } from './TabItem';
import { createLogger } from '../logger';

const logDnd = createLogger('sidebar:dnd');
import {
  useWorkspaceStore,
  collectPaneIds,
  collectPaneLeafs,
  getPaneContextById
} from '../store/workspace-store';
import type { PathContext } from '../../../shared/shell-profiles';
import { useNotificationStore } from '../store/notification-store';
import { useSidebarSectionsStore } from '../store/sidebar-sections-store';
import { useCwdStore } from '../store/cwd-store';

import { serializePane } from '../hooks/use-terminal';
import { injectLiveCwd, getFirstPaneLiveCwd } from '../lib/workspace-utils';
import { formatShortcut, getShortcut } from '../lib/shortcuts';
import { getFileSave } from '../lib/file-save-registry';
import { popperAnim, dialogFadeAnim } from '../lib/motion';
import type { Workspace, PaneLeaf, Tab } from '../../../shared/types';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH_RATIO,
  type UserGroupColor
} from './sidebar-constants';
import { ColorPalettePicker } from './ColorPalettePicker';
import { COLOR_MAP } from './sidebar-constants';
import { buildTabNesting } from '../lib/tab-nesting';
import { EnvSyncBadge } from './env-sync/EnvSyncBadge';
import { EnvSyncConflictDialog } from './env-sync/EnvSyncConflictDialog';
import { SessionsTabCard } from './sessions/SessionsTabCard';
import { useSettingsStore } from '../store/settings-store';
import { TOGGLEABLE_TOOLS } from '../../../shared/tools';

// Platform constant, so resolve it once at module load (same pattern as CommandPalette).
const NEW_TAB_HINT = (() => {
  const def = getShortcut('new-tab');
  return def ? ` (${formatShortcut(def)})` : '';
})();

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

function UserGroupHeader({
  group,
  tabCount,
  onToggle,
  onRename,
  onRecolor,
  onUngroupAll,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver
}: {
  group: { id: string; name: string; color: UserGroupColor; collapsed: boolean };
  tabCount: number;
  onToggle: () => void;
  onRename: (name: string) => void;
  onRecolor: (color: UserGroupColor) => void;
  onUngroupAll: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  isDragOver: 'above' | 'below' | null;
}): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(trimmed);
    }
    setIsEditing(false);
  }, [editValue, group.name, onRename]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="group/ugroup flex items-center gap-1.5 px-2 py-2 mt-2 cursor-pointer rounded-md text-xs text-fleet-text-secondary hover:text-fleet-text hover:bg-fleet-surface-2/50 transition-colors relative select-none"
          onClick={onToggle}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', 'userGroup');
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
          <span className={`w-2 h-2 rounded-full ${COLOR_MAP[group.color]} flex-shrink-0`} />
          <ChevronRight
            size={12}
            className={`transition-transform flex-shrink-0 ${group.collapsed ? '' : 'rotate-90'}`}
          />
          {isEditing ? (
            <input
              ref={inputRef}
              className="flex-1 bg-fleet-surface-3 text-fleet-text text-xs rounded px-1 py-0 outline-none border border-blue-500 min-w-0"
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
              className="truncate"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditValue(group.name);
                setIsEditing(true);
              }}
            >
              {group.name}
            </span>
          )}
          <span className="ml-auto text-[10px] text-fleet-text-subtle">
            {group.collapsed ? `${tabCount} tabs` : ''}
          </span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={`min-w-[140px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50 ${popperAnim}`}
        >
          <ContextMenu.Item
            className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
            onSelect={() => {
              setEditValue(group.name);
              setTimeout(() => setIsEditing(true), 0);
            }}
          >
            Rename
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3 data-[state=open]:bg-fleet-surface-3 flex items-center justify-between">
              Recolor
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="min-w-[180px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 z-50">
                <ColorPalettePicker selected={group.color} onSelect={onRecolor} />
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
          <ContextMenu.Item
            className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-red-900/50 hover:bg-red-900/50 text-red-400"
            onSelect={onUngroupAll}
          >
            Ungroup All
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

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
  isDragOver
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
          className="group/header flex items-center gap-1.5 px-2 py-2 mt-2 cursor-pointer rounded-md text-xs text-fleet-text-secondary hover:text-fleet-text hover:bg-fleet-surface-2/50 transition-colors relative select-none"
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
              className="flex-1 bg-fleet-surface-3 text-fleet-text text-xs rounded px-1 py-0 outline-none border border-blue-500 min-w-0"
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
              <span className="text-[10px] text-fleet-text-subtle">{tabCount} tabs</span>
            )}
            <button
              className="opacity-60 group-hover/header:opacity-100 text-fleet-text-muted hover:text-fleet-text w-5 h-5 flex items-center justify-center text-sm rounded border border-fleet-border-strong hover:border-fleet-border-strong hover:bg-fleet-surface-3 transition active:scale-90 cursor-pointer"
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
        <ContextMenu.Content
          className={`min-w-[140px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50 ${popperAnim}`}
        >
          <ContextMenu.Item
            className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
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

function AnnotateTabCard({
  isActive,
  onClick
}: {
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      // Same treatment as the Sessions card: theme tokens, no CRT scanline
      // overlay and no teal glow. The tool keeps its colour on the icon, which
      // is where an identity belongs once the label stops shouting.
      className={`cursor-pointer rounded-md overflow-hidden relative border transition-colors ${
        isActive
          ? 'bg-fleet-glass-surface-2 border-fleet-border-strong'
          : 'bg-fleet-glass-surface border-fleet-border hover:bg-fleet-glass-surface-2'
      }`}
    >
      <div className="relative z-20 flex items-center gap-2.5 px-2.5 py-2">
        {/* Icon */}
        <div className="flex-shrink-0 w-8 h-8 rounded-md overflow-hidden bg-fleet-surface-2/50 flex items-center justify-center">
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke={isActive ? 'rgb(94,234,212)' : 'rgba(94,234,212,0.6)'}
            strokeWidth="1.5"
          >
            <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </div>

        {/* Label */}
        <div className="flex-1 min-w-0">
          <div
            className={`text-xs font-medium leading-tight ${
              isActive ? 'text-fleet-text' : 'text-fleet-text-secondary'
            }`}
          >
            Annotate
          </div>
        </div>
      </div>
    </div>
  );
}

function OffScreenBadgeSummary({
  direction,
  count,
  label
}: {
  direction: 'above' | 'below';
  count: number;
  label: string;
}): React.JSX.Element | null {
  if (count === 0) return null;
  const arrow = direction === 'above' ? '\u2191' : '\u2193';
  return (
    <div className="px-3 py-0.5 text-[10px] text-fleet-text-subtle text-center">
      {arrow} {count} {label}
    </div>
  );
}

/**
 * A foldable section header. The chevron is tucked back into the row's own left
 * padding rather than pushing the label right, so the label stays on the column
 * it has always been on and folding does not move the sidebar's vertical rhythm.
 *
 * Only the label and chevron toggle. The controls passed as `children` sit
 * outside the button, so the add and configure buttons keep working while the
 * section is folded and clicking one never folds it by accident.
 */
function SectionHeader({
  label,
  collapsed,
  onToggle,
  children
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-2 py-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="-ml-3 flex items-center gap-1 rounded text-[11px] font-medium text-fleet-text-subtle hover:text-fleet-text-secondary transition-colors"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
        {label}
      </button>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

export function Sidebar({
  updateReady,
  onCollapse,
  onOpenToolsConfig
}: {
  updateReady?: boolean;
  onCollapse: () => void;
  onOpenToolsConfig: () => void;
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
    duplicateTab,
    reorderTab,
    reorderGroup,
    renameWorkspace,
    isDirty,
    markClean,
    collapsedGroups,
    toggleGroupCollapsed,
    createWorktreeGroup,
    closeWorktreeTab,
    renameWorktreeGroup,
    worktreeCloseConfirm,
    setWorktreeCloseConfirm,
    setSidebarWidth,
    createUserGroup,
    renameUserGroup,
    recolorUserGroup,
    setTabUserGroup,
    toggleUserGroupCollapsed,
    reorderUserGroup
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
      duplicateTab: s.duplicateTab,
      reorderTab: s.reorderTab,
      reorderGroup: s.reorderGroup,
      renameWorkspace: s.renameWorkspace,
      isDirty: s.isDirty,
      markClean: s.markClean,
      collapsedGroups: s.collapsedGroups,
      toggleGroupCollapsed: s.toggleGroupCollapsed,
      createWorktreeGroup: s.createWorktreeGroup,
      closeWorktreeTab: s.closeWorktreeTab,
      renameWorktreeGroup: s.renameWorktreeGroup,
      worktreeCloseConfirm: s.worktreeCloseConfirm,
      setWorktreeCloseConfirm: s.setWorktreeCloseConfirm,
      setSidebarWidth: s.setSidebarWidth,
      createUserGroup: s.createUserGroup,
      renameUserGroup: s.renameUserGroup,
      recolorUserGroup: s.recolorUserGroup,
      setTabUserGroup: s.setTabUserGroup,
      toggleUserGroupCollapsed: s.toggleUserGroupCollapsed,
      reorderUserGroup: s.reorderUserGroup
    }))
  );
  const { getTabBadge, getTabActivity } = useNotificationStore();

  // Selected one at a time so each header only re-renders on its own fold.
  const agentsCollapsed = useSidebarSectionsStore((s) => s.collapsed.has('agents'));
  const toolsCollapsed = useSidebarSectionsStore((s) => s.collapsed.has('tools'));
  const workspacesCollapsed = useSidebarSectionsStore((s) => s.collapsed.has('workspaces'));
  const toggleSection = useSidebarSectionsStore((s) => s.toggle);
  const expandSection = useSidebarSectionsStore((s) => s.expand);

  const currentSidebarWidth = workspace.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH;

  // --- Drag-and-drop state ---
  const toolSettings = useSettingsStore((s) => s.settings?.tools);
  const enabledToolCount = toolSettings
    ? TOGGLEABLE_TOOLS.filter((t) => toolSettings[t.type]).length
    : 0;

  // Agent panes get their own pinned section, so they are filtered out of the
  // scrolling tab list rather than listed twice. One pass feeds both the rows
  // and the off-screen summary above them.
  const agentRows = workspace.tabs
    .filter((t) => t.type === 'agent')
    .map((tab) => {
      const paneIds = collectPaneIds(tab.splitRoot);
      return {
        tab,
        paneIds,
        badge: getTabBadge(paneIds),
        activity: getTabActivity(paneIds)
      };
    });

  // Which agents want the user, as a stable string so the measuring effect only
  // re-runs when the set changes. Read off the state rather than the rendered
  // badge: a row showing the activity glyph draws no badge element to find.
  const needyAgentIds = agentRows
    .filter(
      ({ badge, activity }) =>
        badge === 'permission' ||
        badge === 'error' ||
        activity?.state === 'needs_me' ||
        activity?.state === 'error'
    )
    .map(({ tab }) => tab.id)
    .join(',');

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragType, setDragType] = useState<'tab' | 'group' | 'userGroup'>('tab');
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    position: 'above' | 'below';
    isGroupHeader: boolean;
  } | null>(null);

  const [newGroupState, setNewGroupState] = useState<{ tabId: string } | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState<UserGroupColor>('blue');

  // Map tab ID to its real index in workspace.tabs (not the filtered subset index)
  const realIndex = useCallback(
    (tabId: string) => workspace.tabs.findIndex((t) => t.id === tabId),
    [workspace.tabs]
  );

  const handleDragStart = useCallback(
    (index: number, type: 'tab' | 'group' | 'userGroup' = 'tab') => {
      logDnd.debug('dragStart', { index, type, tabId: workspace.tabs[index]?.id });
      setDragIndex(index);
      setDragType(type);
    },
    [workspace.tabs]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number, isGroupHeader = false) => {
      if (dragIndex === null) return;
      const target = e.currentTarget;
      if (!(target instanceof HTMLElement)) return;

      // `.at` rather than `[i]`: indexing types as `Tab` even when the index is past the
      // end, which is exactly what the guard below is here to catch.
      const draggedTab = workspace.tabs.at(dragIndex);
      const targetTab = workspace.tabs.at(index);
      if (!draggedTab || !targetTab) return;

      const dragGroup = draggedTab.groupId;
      const targetGroup = targetTab.groupId;

      if (dragType === 'group') {
        // Group drag: only allow targeting group headers or ungrouped tabs (between-group positions)
        if (!isGroupHeader && targetGroup) {
          setDropTarget(null);
          return;
        }
      } else if (dragType === 'userGroup') {
        if (!isGroupHeader || e.dataTransfer.getData('text/plain') !== 'userGroup') {
          setDropTarget(null);
          return;
        }
      } else {
        // Tab drag
        if (isGroupHeader) {
          // Ungrouped tabs can target group headers to jump over groups
          if (dragGroup) {
            setDropTarget(null);
            return;
          }
        } else if (dragGroup !== targetGroup) {
          // Block cross-group tab moves (handles grouped↔ungrouped and groupA↔groupB)
          setDropTarget(null);
          return;
        }
      }

      const rect = target.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const position = e.clientY < midY ? 'above' : 'below';
      setDropTarget({ index, position, isGroupHeader });
    },
    [dragIndex, dragType, workspace.tabs]
  );

  const handleDrop = useCallback(() => {
    if (dragIndex === null || !dropTarget) {
      logDnd.debug('drop cancelled', { dragIndex, dropTarget });
      return;
    }

    const draggedTab = workspace.tabs.at(dragIndex);

    if (dragType === 'group' && draggedTab?.groupId) {
      // Group drag: move the entire group as a unit
      const toIndex = dropTarget.position === 'below' ? dropTarget.index + 1 : dropTarget.index;
      logDnd.debug('drop group', { groupId: draggedTab.groupId, toIndex });
      reorderGroup(draggedTab.groupId, toIndex);
    } else if (dragType === 'userGroup' && draggedTab?.userGroupId) {
      const userGroups = workspace.userGroups ?? [];
      const ugIndex = userGroups.findIndex((g) => g.id === draggedTab.userGroupId);
      const targetTab = workspace.tabs.at(dropTarget.index);
      const targetUgIdx = targetTab?.userGroupId
        ? userGroups.findIndex((g) => g.id === targetTab.userGroupId)
        : userGroups.length;
      const toIndex = dropTarget.position === 'below' ? targetUgIdx + 1 : targetUgIdx;
      reorderUserGroup(draggedTab.userGroupId, ugIndex !== toIndex ? toIndex : ugIndex);
      setDragIndex(null);
      setDropTarget(null);
      return;
    } else {
      // Tab drag
      const targetTab = workspace.tabs.at(dropTarget.index);
      if (draggedTab?.groupId && draggedTab.groupId !== targetTab?.groupId) {
        logDnd.debug('drop blocked: cross-group', {
          dragGroup: draggedTab.groupId,
          targetGroup: targetTab?.groupId
        });
        setDragIndex(null);
        setDropTarget(null);
        return;
      }

      // When an ungrouped tab targets a group header, "below" means after the entire group
      let toIndex: number;
      const targetIsGroupHeader = !draggedTab?.groupId && targetTab?.groupId;
      if (targetIsGroupHeader && dropTarget.position === 'below') {
        // Find the last tab in this group
        const lastGroupIdx = workspace.tabs.reduce(
          (last, t, i) => (t.groupId === targetTab.groupId ? i : last),
          dropTarget.index
        );
        toIndex = lastGroupIdx + 1;
      } else {
        toIndex = dropTarget.position === 'below' ? dropTarget.index + 1 : dropTarget.index;
      }
      const adjustedTo = dragIndex < toIndex ? toIndex - 1 : toIndex;
      logDnd.debug('drop tab', {
        dragIndex,
        dropTarget,
        rawToIndex: toIndex,
        adjustedTo,
        willReorder: dragIndex !== adjustedTo
      });
      if (dragIndex !== adjustedTo) {
        reorderTab(dragIndex, adjustedTo);
      }
    }

    setDragIndex(null);
    setDropTarget(null);
  }, [
    dragIndex,
    dragType,
    dropTarget,
    reorderTab,
    reorderGroup,
    reorderUserGroup,
    workspace.tabs,
    workspace.userGroups
  ]);

  // --- Worktree creation ---
  const handleCreateWorktree = useCallback(
    async (tabId: string, cwd: string, pathContext?: PathContext) => {
      try {
        const result = await window.fleet.worktree.create({ repoPath: cwd, pathContext });
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

  // Derive live cwd of the active tab (mirrors the same pattern used below for group tabs)
  const activeTab = workspace.tabs.find((t) => t.id === activeTabId) ?? null;
  const activeTabFirstPaneId = activeTab ? (collectPaneIds(activeTab.splitRoot)[0] ?? null) : null;
  const activeCwd =
    activeTab != null
      ? ((activeTabFirstPaneId != null ? liveCwds.get(activeTabFirstPaneId) : undefined) ??
        activeTab.cwd)
      : undefined;

  const [gitRepoTabs, setGitRepoTabs] = useState<Set<string>>(new Set());

  // Key the git probe on exactly what it reads - each tab's id, type and cwd. `workspace.tabs`
  // is a fresh array on every workspace mutation (so it would re-probe constantly), while
  // `workspace.tabs.length` misses a tab's cwd changing under a constant tab count.
  const gitProbeKey = workspace.tabs.map((t) => [t.id, t.type ?? '', t.cwd].join(':')).join('|');

  useEffect(() => {
    const checkGitRepos = async (): Promise<void> => {
      const newSet = new Set<string>();
      for (const tab of useWorkspaceStore.getState().workspace.tabs) {
        if (tab.type && tab.type !== 'terminal') continue;
        const firstPaneId = collectPaneIds(tab.splitRoot)[0];
        const cwd = (firstPaneId ? liveCwds.get(firstPaneId) : undefined) ?? tab.cwd;
        try {
          const result = await window.fleet.git.isRepo(cwd, getPaneContextById(firstPaneId));
          if (result.isRepo) newSet.add(tab.id);
        } catch {
          // ignore
        }
      }
      setGitRepoTabs(newSet);
    };
    void checkGitRepos();
  }, [gitProbeKey, liveCwds]);

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
              splitRoot: injectLiveCwd(tab.splitRoot)
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
              splitRoot: injectLiveCwd(tab.splitRoot)
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

  // Clamp sidebar width when window shrinks below 2× sidebar width
  useEffect(() => {
    const handleWindowResize = (): void => {
      const max = window.innerWidth * MAX_SIDEBAR_WIDTH_RATIO;
      if (currentSidebarWidth > max) {
        setSidebarWidth(max);
      }
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [currentSidebarWidth, setSidebarWidth]);

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
              splitRoot: injectLiveCwd(tab.splitRoot)
            };
          })
      }
    });

    // Start empty; switchWorkspace seeds the default-visible tools, and the
    // terminal tab is added right after (below).
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
  const agentListRef = useRef<HTMLDivElement>(null);
  const sidebarRootRef = useRef<HTMLDivElement>(null);
  const [hasScrollOverflow, setHasScrollOverflow] = useState(false);

  // Auto-scroll active tab into view. Searched across the whole sidebar, not
  // just the tab list, because the pinned agents section scrolls on its own.
  useEffect(() => {
    if (!activeTabId || !sidebarRootRef.current) return;
    const el = sidebarRootRef.current.querySelector(`[data-tab-id="${activeTabId}"]`);
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
      threshold: 0
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

  // Same idea for the pinned agents list, which scrolls inside its own cap: an
  // agent waiting on a permission must not be able to hide off the ends of it.
  const [agentOffScreenCounts, setAgentOffScreenCounts] = useState({ above: 0, below: 0 });

  useEffect(() => {
    const container = agentListRef.current;
    if (!container) {
      setAgentOffScreenCounts({ above: 0, below: 0 });
      return;
    }
    const needy = new Set(needyAgentIds ? needyAgentIds.split(',') : []);

    const countOffScreen = (): void => {
      const containerRect = container.getBoundingClientRect();
      let above = 0;
      let below = 0;
      container.querySelectorAll('[data-tab-id]').forEach((el) => {
        if (!needy.has(el.getAttribute('data-tab-id') ?? '')) return;
        const rect = el.getBoundingClientRect();
        if (rect.bottom < containerRect.top) above++;
        else if (rect.top > containerRect.bottom) below++;
      });
      // Bail out on an unchanged count, or this re-renders on every scroll tick.
      setAgentOffScreenCounts((prev) =>
        prev.above === above && prev.below === below ? prev : { above, below }
      );
    };

    countOffScreen();
    container.addEventListener('scroll', countOffScreen);
    const observer = new ResizeObserver(countOffScreen);
    observer.observe(container);
    return () => {
      container.removeEventListener('scroll', countOffScreen);
      observer.disconnect();
    };
  }, [needyAgentIds, agentRows.length]);

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

  // --- Worktree close confirmation (state lives in workspace store) ---
  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = workspace.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      // Worktree tab: show confirmation before closing
      if (tab.worktreePath) {
        setWorktreeCloseConfirm({ tabId, label: tab.label });
        return;
      }

      // Non-worktree tab in a group (the original/parent): close normally via group logic
      if (tab.groupId) {
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
    [workspace.tabs, doCloseTab, closeWorktreeTab, setWorktreeCloseConfirm]
  );

  const confirmWorktreeClose = useCallback(() => {
    if (!worktreeCloseConfirm) return;
    const tab = workspace.tabs.find((t) => t.id === worktreeCloseConfirm.tabId);
    if (!tab) return;
    // Close via group logic (handles group dissolution) — undo toast will appear in App.tsx
    // Worktree cleanup happens in App.tsx when undo window expires
    closeWorktreeTab(worktreeCloseConfirm.tabId);
    setWorktreeCloseConfirm(null);
  }, [worktreeCloseConfirm, workspace.tabs, closeWorktreeTab, setWorktreeCloseConfirm]);

  return (
    <div
      ref={sidebarRootRef}
      // A card on the canvas like the panes, not a wall welded to the window
      // edge. No right margin on purpose: the pane grid's own padding already
      // supplies 8px there, which is the gutter panes have with each other and
      // with the window. The width style is the content box, so these margins
      // sit outside it and the resize maths is unaffected.
      className="relative flex flex-col my-2 ml-2 rounded-lg bg-fleet-glass-chrome border border-fleet-border shadow-md shadow-black/20 shrink-0"
      style={{ width: currentSidebarWidth }}
    >
      {/* Drag region + workspace label with add button */}
      <div className="px-3 pt-2 pb-3 flex items-center justify-between">
        <div style={{ WebkitAppRegion: 'no-drag' }} className="flex-1 min-w-0 mr-2">
          {isEditingWsLabel ? (
            <input
              ref={wsLabelInputRef}
              className="w-full bg-fleet-surface-3 text-fleet-text text-[11px] font-medium rounded px-1 py-0.5 outline-none border border-blue-500"
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
                <span className="text-[11px] font-medium text-fleet-text-subtle cursor-default select-none">
                  {workspace.label}
                </span>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content
                  className={`min-w-[140px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50 ${popperAnim}`}
                >
                  <ContextMenu.Item
                    className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
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
          {/* Env sync badge for active tab's repo */}
          <EnvSyncBadge cwd={activeCwd} pathContext={getPaneContextById(activeTabFirstPaneId)} />
          {/* Dirty state indicator */}
          {isDirty && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" title="Unsaved changes" />
          )}
          {/* Add tab button */}
          <button
            className="text-fleet-text-subtle hover:text-fleet-text text-lg leading-none px-1 rounded hover:bg-fleet-surface-2 transition active:scale-90"
            onClick={() => addTab(undefined, window.fleet.homeDir)}
            title={`New Tab${NEW_TAB_HINT}`}
          >
            +
          </button>
          <button
            className="text-fleet-text-subtle hover:text-fleet-text px-1 rounded hover:bg-fleet-surface-2 transition active:scale-90"
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
        <OffScreenBadgeSummary
          direction="above"
          count={offScreenCounts.above}
          label="need attention"
        />
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
          {(() => {
            const regularTabs = workspace.tabs.filter(
              (t) =>
                t.type !== 'settings' &&
                t.type !== 'annotate' &&
                t.type !== 'sessions' &&
                t.type !== 'agent'
            );

            const rendered: React.ReactNode[] = [];
            const seenWorktreeGroups = new Set<string>();
            const userGroups = workspace.userGroups ?? [];
            // Files opened from a session hang off it. They are drawn by the
            // session's own pass rather than at their place in the list, so a
            // collapsed group or a moved session takes them along for free.
            const nesting = buildTabNesting(regularTabs);

            const USER_GROUP_BORDER_CLASSES: Record<string, string> = {
              blue: 'border-l-blue-500/50',
              teal: 'border-l-teal-500/50',
              green: 'border-l-green-500/50',
              yellow: 'border-l-yellow-500/50',
              orange: 'border-l-orange-500/50',
              red: 'border-l-red-500/50',
              pink: 'border-l-pink-500/50',
              purple: 'border-l-purple-500/50'
            };

            const renderTabWithWorktreeGroups = (
              tab: (typeof regularTabs)[number],
              /** Set when the tab is drawn under its session, which fixes its indent. */
              nestedIndent?: number
            ): void => {
              if (tab.groupId && !seenWorktreeGroups.has(tab.groupId)) {
                seenWorktreeGroups.add(tab.groupId);
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
                      const anyTab = groupTabs[0];
                      const firstPane = collectPaneIds(anyTab.splitRoot)[0];
                      const cwd = (firstPane ? liveCwds.get(firstPane) : undefined) ?? anyTab.cwd;
                      void handleCreateWorktree(anyTab.id, cwd, getPaneContextById(firstPane));
                    }}
                    onDragStart={() => handleDragStart(firstTabIdx, 'group')}
                    onDragOver={(e) => handleDragOver(e, firstTabIdx, true)}
                    onDrop={() => handleDrop()}
                    isDragOver={
                      dropTarget?.index === firstTabIdx && dropTarget.isGroupHeader
                        ? dropTarget.position
                        : null
                    }
                  />
                );
              }

              if (tab.groupId && collapsedGroups.has(tab.groupId)) return;

              const indentLevel = nestedIndent ?? (tab.groupId ? 1 : 0);
              const paneIds = collectPaneIds(tab.splitRoot);
              const isFile =
                tab.type === 'file' ||
                tab.type === 'image' ||
                tab.type === 'markdown' ||
                tab.type === 'pdf';
              const idx = realIndex(tab.id);

              let displayCwd: string;
              let drivingPaneId: string | undefined;
              if (isFile) {
                const leafs = collectPaneLeafs(tab.splitRoot);
                // Remote panes have no local filePath - their location is the
                // remote path, which is also what the user recognises.
                const filePath = leafs[0]?.remotePath ?? leafs[0]?.filePath ?? '';
                displayCwd = filePath ? filePath.split('/').slice(0, -1).join('/') || '/' : '/';
              } else if (tab.type === 'ssh-browser') {
                const leafs = collectPaneLeafs(tab.splitRoot);
                displayCwd = leafs[0]?.remoteHost?.host ?? tab.cwd;
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
              if (tab.type === 'agent') {
                icon = <Bot size={14} />;
              } else if (tab.type === 'ssh-browser') {
                icon = <Server size={14} />;
              } else if (isFile) {
                const leafs2 = collectPaneLeafs(tab.splitRoot);
                const fileBasename =
                  (leafs2[0]?.remotePath ?? leafs2[0]?.filePath)?.split('/').pop() ?? tab.label;
                icon =
                  tab.type === 'image' ? <ImageIcon size={14} /> : getFileIcon(fileBasename, 14);
              } else {
                icon = <Terminal size={14} />;
              }

              const ug = userGroups.find((g) => g.id === tab.userGroupId);
              const userGroupBorder = ug ? USER_GROUP_BORDER_CLASSES[ug.color] : undefined;

              const userGroupList = userGroups.map((g) => ({
                id: g.id,
                name: g.name,
                color: g.color
              }));

              rendered.push(
                <TabItem
                  key={tab.id}
                  id={tab.id}
                  label={displayLabel}
                  labelIsCustom={tab.labelIsCustom}
                  cwd={displayCwd}
                  drivingPaneId={drivingPaneId}
                  isActive={tab.id === activeTabId}
                  badge={getTabBadge(paneIds)}
                  activity={getTabActivity(paneIds)}
                  icon={icon}
                  disableReset={isFile}
                  index={idx}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  isDragOver={
                    dropTarget?.index === idx && !dropTarget.isGroupHeader
                      ? dropTarget.position
                      : null
                  }
                  indentLevel={indentLevel}
                  indentAccent={nestedIndent === undefined ? 'worktree' : 'nested'}
                  worktreeBranch={tab.worktreeBranch}
                  pathContext={tab.pathContext}
                  worktreeDisabledReason={
                    isFile
                      ? undefined
                      : tab.groupRole === 'worktree'
                        ? 'Already a worktree'
                        : tab.groupId
                          ? 'Worktrees already created'
                          : !gitRepoTabs.has(tab.id)
                            ? 'Not a git repository'
                            : null
                  }
                  onCreateWorktree={
                    !isFile && gitRepoTabs.has(tab.id) && !tab.worktreePath && !tab.groupId
                      ? () => {
                          const firstPane = collectPaneIds(tab.splitRoot)[0];
                          const liveCwd = firstPane ? liveCwds.get(firstPane) : undefined;
                          void handleCreateWorktree(
                            tab.id,
                            liveCwd ?? tab.cwd,
                            getPaneContextById(firstPane)
                          );
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
                  onDuplicate={
                    !isFile && (!tab.type || tab.type === 'terminal')
                      ? () => duplicateTab(tab.id)
                      : undefined
                  }
                  onClose={() => handleCloseTab(tab.id)}
                  onRename={(newLabel) => renameTab(tab.id, newLabel)}
                  onResetLabel={(liveCwd) => resetTabLabel(tab.id, liveCwd)}
                  userGroupColor={userGroupBorder}
                  userGroupId={tab.userGroupId}
                  userGroups={userGroupList}
                  onCreateGroup={
                    tab.userGroupId
                      ? undefined
                      : () => {
                          setNewGroupState({ tabId: tab.id });
                          setNewGroupName('');
                          setNewGroupColor('blue');
                        }
                  }
                  onAddToGroup={
                    userGroups.length > 0 && !tab.userGroupId
                      ? (groupId) => setTabUserGroup(tab.id, groupId)
                      : undefined
                  }
                  onRemoveFromGroup={
                    tab.userGroupId ? () => setTabUserGroup(tab.id, undefined) : undefined
                  }
                />
              );

              for (const child of nesting.childrenByParent.get(tab.id) ?? []) {
                renderTabWithWorktreeGroups(child, indentLevel + 1);
              }
            };

            // 1. Ungrouped tabs render first
            for (const tab of regularTabs.filter(
              (t) => !t.userGroupId && !nesting.nestedIds.has(t.id)
            )) {
              renderTabWithWorktreeGroups(tab);
            }

            // 2. User groups
            for (const ug of userGroups) {
              const groupTabs = regularTabs.filter(
                (t) => t.userGroupId === ug.id && !nesting.nestedIds.has(t.id)
              );
              if (groupTabs.length === 0) continue;

              const firstTabIdx = realIndex(groupTabs[0].id);

              rendered.push(
                <UserGroupHeader
                  key={`ug-${ug.id}`}
                  group={ug}
                  tabCount={groupTabs.length}
                  onToggle={() => toggleUserGroupCollapsed(ug.id)}
                  onRename={(name) => renameUserGroup(ug.id, name)}
                  onRecolor={(color) => recolorUserGroup(ug.id, color)}
                  onUngroupAll={() => {
                    for (const t of groupTabs) setTabUserGroup(t.id, undefined);
                  }}
                  onDragStart={() => handleDragStart(firstTabIdx, 'userGroup')}
                  onDragOver={(e) => handleDragOver(e, firstTabIdx, true)}
                  onDrop={() => handleDrop()}
                  isDragOver={
                    dropTarget?.index === firstTabIdx && dropTarget.isGroupHeader
                      ? dropTarget.position
                      : null
                  }
                />
              );

              if (ug.collapsed) continue;

              for (const tab of groupTabs) {
                renderTabWithWorktreeGroups(tab);
              }
            }

            return rendered;
          })()}
          {newGroupState && (
            <div className="px-2 py-2 bg-fleet-surface-2 border border-fleet-border-strong rounded-md mx-1 mb-2">
              <input
                autoFocus
                className="w-full bg-fleet-surface-3 text-fleet-text text-sm rounded px-2 py-1 outline-none border border-fleet-border-strong mb-2"
                placeholder="Group name..."
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const name = newGroupName.trim() || 'Group';
                    createUserGroup(name, newGroupColor, newGroupState.tabId);
                    setNewGroupState(null);
                  }
                  if (e.key === 'Escape') setNewGroupState(null);
                }}
              />
              <ColorPalettePicker selected={newGroupColor} onSelect={setNewGroupColor} />
              <div className="flex justify-end gap-1.5 mt-1.5">
                <button
                  className="px-2 py-0.5 text-xs text-fleet-text-muted hover:text-fleet-text rounded transition"
                  onClick={() => setNewGroupState(null)}
                >
                  Cancel
                </button>
                <button
                  className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition"
                  onClick={() => {
                    const name = newGroupName.trim() || 'Group';
                    createUserGroup(name, newGroupColor, newGroupState.tabId);
                    setNewGroupState(null);
                  }}
                >
                  Create
                </button>
              </div>
            </div>
          )}
        </div>
        {/* Scroll overflow shadow indicator */}
        {hasScrollOverflow && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-fleet-surface/90 to-transparent z-10" />
        )}
        <OffScreenBadgeSummary
          direction="below"
          count={offScreenCounts.below}
          label="need attention"
        />
      </div>

      {/* Pinned agents section */}
      <div className="border-t border-fleet-border px-2 py-2 space-y-0.5">
        <SectionHeader
          label="Agents"
          collapsed={agentsCollapsed}
          onToggle={() => toggleSection('agents')}
        >
          {agentRows.length > 0 && (
            <span className="text-[10px] font-medium tabular-nums text-fleet-text-subtle">
              {agentRows.length}
            </span>
          )}
          <button
            className="text-fleet-text-subtle hover:text-fleet-text text-sm leading-none px-1 rounded hover:bg-fleet-surface-2 transition active:scale-90"
            // The pane needs a folder to work in, so the same event the
            // command palette fires opens the picker first.
            onClick={() => {
              expandSection('agents');
              document.dispatchEvent(new CustomEvent('fleet:new-agent'));
            }}
            title="New Agent Pane"
          >
            +
          </button>
        </SectionHeader>
        {!agentsCollapsed && agentRows.length > 0 && (
          <>
            <OffScreenBadgeSummary
              direction="above"
              count={agentOffScreenCounts.above}
              label="need attention"
            />
            <div ref={agentListRef} className="max-h-[30vh] overflow-y-auto space-y-0.5">
              {agentRows.map(({ tab, paneIds, badge, activity }) => (
                <TabItem
                  key={tab.id}
                  id={tab.id}
                  label={tab.label}
                  labelIsCustom={tab.labelIsCustom}
                  cwd={tab.cwd}
                  drivingPaneId={
                    tab.id === activeTabId && activePaneId && paneIds.includes(activePaneId)
                      ? activePaneId
                      : paneIds[0]
                  }
                  isActive={tab.id === activeTabId}
                  badge={badge}
                  activity={activity}
                  icon={<Bot size={14} />}
                  index={realIndex(tab.id)}
                  pathContext={tab.pathContext}
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
              ))}
            </div>
            <OffScreenBadgeSummary
              direction="below"
              count={agentOffScreenCounts.below}
              label="need attention"
            />
          </>
        )}
      </div>

      {/* Pinned tools section */}
      <div className="border-t border-fleet-border px-2 py-2 space-y-0.5">
        <SectionHeader
          label="Tools"
          collapsed={toolsCollapsed}
          onToggle={() => toggleSection('tools')}
        >
          <span
            className="text-[10px] font-medium tabular-nums text-fleet-text-subtle"
            title={`${enabledToolCount} of ${TOGGLEABLE_TOOLS.length} tools enabled`}
          >
            {enabledToolCount}/{TOGGLEABLE_TOOLS.length}
          </span>
          <button
            className="text-fleet-text-subtle hover:text-fleet-text rounded p-0.5 hover:bg-fleet-surface-2 transition active:scale-90"
            onClick={onOpenToolsConfig}
            title="Configure tools"
          >
            <SlidersHorizontal size={13} />
          </button>
        </SectionHeader>
        {!toolsCollapsed && (
          <>
            {/* Annotate tab (pinned, not closeable) */}
            {workspace.tabs
              .filter((tab) => tab.type === 'annotate')
              .map((tab) => (
                <AnnotateTabCard
                  key={tab.id}
                  isActive={tab.id === activeTabId}
                  onClick={() => setActiveTab(tab.id)}
                />
              ))}
            {/* Sessions tab (pinned, not closeable) */}
            {workspace.tabs
              .filter((tab) => tab.type === 'sessions')
              .map((tab) => (
                <SessionsTabCard
                  key={tab.id}
                  isActive={tab.id === activeTabId}
                  onClick={() => setActiveTab(tab.id)}
                />
              ))}
          </>
        )}
      </div>

      {/* Bottom section: workspaces */}
      <div className="border-t border-fleet-border px-2 py-2 space-y-0.5">
        <SectionHeader
          label="Workspaces"
          collapsed={workspacesCollapsed}
          onToggle={() => toggleSection('workspaces')}
        >
          <button
            className="text-fleet-text-subtle hover:text-fleet-text text-sm leading-none px-1 rounded hover:bg-fleet-surface-2 transition active:scale-90"
            onClick={() => {
              expandSection('workspaces');
              setShowNewWsInput(true);
              setNewWsName('');
            }}
            title="New Workspace"
          >
            +
          </button>
        </SectionHeader>

        {/* Inline new workspace name input */}
        {!workspacesCollapsed && showNewWsInput && (
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
              className="w-full px-2 py-1 text-sm bg-fleet-surface-2 text-fleet-text border border-fleet-border-strong rounded focus:border-blue-500 focus:outline-none"
            />
          </div>
        )}

        {/* Saved workspaces list */}
        {!workspacesCollapsed &&
          savedWorkspaces
            .filter((ws) => ws.id !== workspace.id)
            .map((ws) => (
              <div key={ws.id} className="relative">
                {deleteConfirmId === ws.id ? (
                  <div className="flex flex-col gap-1 px-2 py-2 bg-fleet-surface-2 rounded-md text-xs">
                    <span className="text-red-400">Delete this workspace?</span>
                    <div className="flex gap-2">
                      <button
                        className="px-2 py-0.5 bg-red-600 hover:bg-red-500 text-white rounded transition active:scale-[0.97]"
                        onClick={() => {
                          void handleDeleteWorkspace(ws.id);
                        }}
                      >
                        Delete
                      </button>
                      <button
                        className="px-2 py-0.5 bg-fleet-surface-3 hover:bg-fleet-surface-3 text-fleet-text-secondary rounded transition active:scale-[0.97]"
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
                      className="w-full px-2 py-1 text-sm bg-fleet-surface-2 text-fleet-text border border-fleet-border-strong rounded focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                ) : (
                  <ContextMenu.Root>
                    <ContextMenu.Trigger asChild>
                      <button
                        className="w-full flex items-center justify-between px-2 py-1.5 text-sm text-fleet-text-muted hover:text-fleet-text hover:bg-fleet-surface-2 rounded-md transition active:scale-[0.97]"
                        onClick={() => handleSwitchWorkspace(ws.id)}
                        title={`Switch to ${ws.label}`}
                      >
                        <span className="truncate">{ws.label}</span>
                        <span className="text-xs text-fleet-text-subtle hover:text-blue-400 ml-1 flex-shrink-0">
                          Open
                        </span>
                      </button>
                    </ContextMenu.Trigger>
                    <ContextMenu.Portal>
                      <ContextMenu.Content
                        className={`min-w-[140px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50 ${popperAnim}`}
                      >
                        <ContextMenu.Item
                          className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
                          onSelect={() => {
                            setRenamingWsValue(ws.label);
                            setTimeout(() => setRenamingWsId(ws.id), 0);
                          }}
                        >
                          Rename
                        </ContextMenu.Item>
                        <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
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
      <div className="border-t border-fleet-border px-3 py-2 space-y-1">
        {(() => {
          const isSettingsActive = workspace.tabs.some(
            (t) => t.type === 'settings' && t.id === activeTabId
          );
          return (
            <button
              className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md transition active:scale-[0.97] ${
                isSettingsActive
                  ? 'text-fleet-text bg-fleet-surface-3 ring-1 ring-fleet-border-strong'
                  : 'text-fleet-text-muted hover:text-fleet-text hover:bg-fleet-surface-2'
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
          <Dialog.Overlay className={`fixed inset-0 bg-fleet-bg/60 z-50 ${dialogFadeAnim}`} />
          <Dialog.Content
            className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-fleet-surface border border-fleet-border-strong rounded-lg shadow-xl p-5 w-80 text-sm ${dialogFadeAnim}`}
          >
            <Dialog.Title className="text-base font-semibold text-fleet-text mb-1">
              Save changes to &ldquo;{fileCloseConfirm?.label}&rdquo;?
            </Dialog.Title>
            <Dialog.Description className="text-fleet-text-muted mb-5 text-xs">
              Your changes will be lost if you don&apos;t save.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-xs text-fleet-text-muted hover:text-fleet-text hover:bg-fleet-surface-2 rounded transition active:scale-[0.97]"
                onClick={() => {
                  if (fileCloseConfirm) doCloseTab(fileCloseConfirm.tabId);
                  setFileCloseConfirm(null);
                }}
              >
                Don&apos;t Save
              </button>
              <button
                className="px-3 py-1.5 text-xs text-fleet-text-muted hover:text-fleet-text hover:bg-fleet-surface-2 rounded transition active:scale-[0.97]"
                onClick={() => setFileCloseConfirm(null)}
              >
                Cancel
              </button>
              <button
                disabled={fileSaving}
                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition active:scale-[0.97] disabled:active:scale-100 font-medium"
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

      {/* Worktree close confirmation dialog */}
      <Dialog.Root
        open={!!worktreeCloseConfirm}
        onOpenChange={(open) => {
          if (!open) setWorktreeCloseConfirm(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={`fixed inset-0 bg-fleet-bg/60 z-50 ${dialogFadeAnim}`} />
          <Dialog.Content
            className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-fleet-surface border border-fleet-border-strong rounded-lg shadow-xl p-5 w-80 text-sm ${dialogFadeAnim}`}
          >
            <Dialog.Title className="text-base font-semibold text-fleet-text mb-1">
              Remove worktree &ldquo;{worktreeCloseConfirm?.label}&rdquo;?
            </Dialog.Title>
            <Dialog.Description className="text-fleet-text-muted mb-5 text-xs">
              This will destroy the worktree and its directory. Any work not committed and pushed
              will be lost.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-xs text-fleet-text-muted hover:text-fleet-text hover:bg-fleet-surface-2 rounded transition active:scale-[0.97]"
                onClick={() => setWorktreeCloseConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition active:scale-[0.97] font-medium"
                onClick={confirmWorktreeClose}
              >
                Remove
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {/* Env sync conflict dialog — renders nothing until a conflict event fires */}
      <EnvSyncConflictDialog />
      {/* Right-edge drag handle for resizing */}
      <SidebarResizeHandle
        sidebarRef={sidebarRootRef}
        onResize={setSidebarWidth}
        onReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      />
    </div>
  );
}
