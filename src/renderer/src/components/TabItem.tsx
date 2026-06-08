import { useState, useRef, useEffect, useCallback } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { GitBranch } from 'lucide-react';
import { createLogger } from '../logger';

const logDnd = createLogger('sidebar:dnd');
import type { NotificationLevel } from '../../../shared/types';
import type { PathContext } from '../../../shared/shell-profiles';
import { cwdBasename } from '../store/workspace-store';
import { useCwdStore } from '../store/cwd-store';
import { useRemoteStore } from '../store/remote-store';
import { useNotificationStore } from '../store/notification-store';
import { shortenPath } from '../lib/shorten-path';
import { popperAnim } from '../lib/motion';

type TabItemProps = {
  id: string;
  label: string;
  labelIsCustom: boolean;
  cwd: string;
  /** Pane ID to subscribe to for live CWD updates. When provided, TabItem
   *  subscribes to just this pane's CWD via a granular selector — only
   *  re-rendering when THIS pane's CWD changes, not when any other pane's does. */
  drivingPaneId?: string;
  isActive: boolean;
  badge: NotificationLevel | null;
  icon?: React.ReactNode;
  onClick: () => void;
  onDuplicate?: () => void;
  onClose: () => void;
  onRename: (newLabel: string) => void;
  onResetLabel: (liveCwd: string) => void;
  disableReset?: boolean;
  // Drag-and-drop
  index: number;
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (index: number) => void;
  isDragOver: 'above' | 'below' | null;
  /** Tailwind border color class for active state. Defaults to 'border-blue-500'. */
  activeBorderColor?: string;
  /** Called when user selects "Create Worktree" from context menu */
  onCreateWorktree?: () => void;
  /** null = enabled, string = disabled with this reason shown as subtitle. undefined = don't show item at all (non-terminal tabs). */
  worktreeDisabledReason?: string | null;
  /** Branch name to show as subtitle for worktree tabs */
  worktreeBranch?: string;
  /** Path semantics for rendering the auto-label. Undefined = treat as POSIX. */
  pathContext?: PathContext;
  /** Indentation level (0 = normal, 1 = inside a group) */
  indentLevel?: number;
};

// Multi-signal badge config: color + size + shape + animation per severity level
// so badge meaning is not conveyed by color alone (WCAG, Baymard, NNG)
const BADGE_CONFIG: Record<
  NotificationLevel,
  { color: string; size: string; animate: string; label: string }
> = {
  permission: { color: 'bg-amber-400', size: 'w-2.5 h-2.5', animate: 'animate-pulse', label: '?' },
  error: { color: 'bg-red-400', size: 'w-2.5 h-2.5', animate: '', label: '!' },
  info: { color: 'bg-blue-400', size: 'w-2 h-2', animate: '', label: '' },
  subtle: { color: 'bg-green-500', size: 'w-1.5 h-1.5', animate: '', label: '' }
};

function formatFreshness(lastOutputAt: number, state: string): string | null {
  if (state === 'working' || !lastOutputAt) return null;
  const elapsed = Date.now() - lastOutputAt;
  if (elapsed < 10_000) return null; // Don't show for <10s
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  if (minutes > 0) {
    const timeStr = `${minutes}m ago`;
    return state === 'needs_me' ? `${minutes}m waiting` : timeStr;
  }
  const timeStr = `${seconds}s ago`;
  return state === 'needs_me' ? `${seconds}s waiting` : timeStr;
}

export function TabItem({
  id,
  label,
  labelIsCustom,
  cwd: fallbackCwd,
  drivingPaneId,
  isActive,
  badge,
  icon,
  onClick,
  onDuplicate,
  onClose,
  onRename,
  onResetLabel,
  disableReset,
  index,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
  activeBorderColor = 'border-blue-500',
  onCreateWorktree,
  worktreeDisabledReason,
  worktreeBranch,
  pathContext,
  indentLevel = 0
}: TabItemProps): React.JSX.Element {
  // Granular CWD subscription — only re-renders when THIS pane's CWD changes
  const liveCwd = useCwdStore((s) => (drivingPaneId ? s.cwds.get(drivingPaneId) : undefined));
  const cwd = liveCwd ?? fallbackCwd;
  // Granular subscription — only re-renders when THIS pane's remote state changes
  const isRemote = useRemoteStore((s) => (drivingPaneId ? s.remotes.has(drivingPaneId) : false));
  const activity = useNotificationStore((s) =>
    drivingPaneId ? s.getActivity(drivingPaneId) : undefined
  );

  const [freshness, setFreshness] = useState<string | null>(null);

  useEffect(() => {
    if (!activity || activity.state === 'working') {
      setFreshness(null);
      return;
    }
    // Update freshness every 10s
    const update = (): void => setFreshness(formatFreshness(activity.lastOutputAt, activity.state));
    update();
    const interval = setInterval(update, 10_000);
    return () => clearInterval(interval);
  }, [activity]);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Listen for F2 rename event on the active tab
  useEffect(() => {
    if (!isActive) return;
    const handleRenameEvent = (): void => {
      setEditValue(label);
      setIsEditing(true);
    };
    document.addEventListener('fleet:rename-active-tab', handleRenameEvent);
    return () => document.removeEventListener('fleet:rename-active-tab', handleRenameEvent);
  }, [isActive, label]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== label) {
      onRename(trimmed);
    }
    setIsEditing(false);
  }, [editValue, label, onRename]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setEditValue(label);
      setIsEditing(true);
    },
    [label]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        commitRename();
      } else if (e.key === 'Escape') {
        setIsEditing(false);
      }
    },
    [commitRename]
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          data-tab-id={id}
          className={`
            group flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-md text-sm relative min-h-[44px] transition-colors
            ${indentLevel > 0 ? 'ml-4 border-l-2 border-l-teal-500/50' : ''}
            ${
              isActive
                ? `bg-fleet-surface-3 text-fleet-text ${indentLevel > 0 ? '' : `border-l-2 ${activeBorderColor}`}`
                : `text-fleet-text-secondary hover:bg-fleet-surface-2 hover:text-fleet-text ${indentLevel > 0 ? '' : 'border-l-2 border-transparent'}`
            }
          `}
          onClick={onClick}
          title={labelIsCustom ? `${label} — ${cwd}` : cwd}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(index));
            logDnd.debug('tabItem dragStart', { tabId: id, index, label });
            onDragStart(index);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            onDragOver(e, index);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            logDnd.debug('tabItem drop', { tabId: id, index, label });
            onDrop(index);
          }}
        >
          {/* Drop indicator line above */}
          {isDragOver === 'above' && (
            <div className="absolute top-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full -translate-y-0.5" />
          )}
          {/* Drop indicator line below */}
          {isDragOver === 'below' && (
            <div className="absolute bottom-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full translate-y-0.5" />
          )}

          {badge && !isActive && (
            <span
              className={`rounded-full flex-shrink-0 flex items-center justify-center ${BADGE_CONFIG[badge].color} ${BADGE_CONFIG[badge].size} ${BADGE_CONFIG[badge].animate}`}
              aria-label={`${badge} notification`}
            >
              {BADGE_CONFIG[badge].label && (
                <span className="text-[7px] font-bold text-black leading-none">
                  {BADGE_CONFIG[badge].label}
                </span>
              )}
            </span>
          )}

          {icon && (
            <span
              className={`flex-shrink-0 ${isActive ? 'text-fleet-text-muted' : 'text-fleet-text-subtle'}`}
            >
              {icon}
            </span>
          )}

          {isEditing ? (
            <input
              ref={inputRef}
              className="flex-1 bg-fleet-surface-3 text-fleet-text text-sm rounded px-1 py-0 outline-none border border-blue-500 min-w-0"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="flex-1 min-w-0" onDoubleClick={handleDoubleClick}>
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm leading-tight">
                  {labelIsCustom ? label : cwdBasename(cwd, pathContext ?? 'posix')}
                </span>
                {isRemote && (
                  <span
                    className="flex-shrink-0 rounded bg-purple-500/20 px-1 py-px text-[9px] font-medium uppercase leading-none tracking-wide text-purple-300"
                    aria-label="remote session"
                  >
                    remote
                  </span>
                )}
              </div>
              <div className="truncate text-xs leading-tight text-fleet-text-muted">
                {worktreeBranch ? (
                  <span className="text-teal-400/60">{worktreeBranch}</span>
                ) : freshness ? (
                  <span className={activity?.state === 'needs_me' ? 'text-amber-400' : ''}>
                    {freshness}
                  </span>
                ) : (
                  shortenPath(cwd)
                )}
              </div>
            </div>
          )}

          {/* Always-visible close button (dimmed when not hovered) */}
          <button
            className="opacity-40 group-hover:opacity-100 px-1 text-fleet-text-muted hover:text-red-400 hover:border-2 hover:border-red-500 rounded transition-opacity active:scale-90"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            &times;
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={`min-w-[140px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50 ${popperAnim}`}
        >
          {onDuplicate && (
            <ContextMenu.Item
              className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
              onSelect={onDuplicate}
            >
              Duplicate Tab
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
            onSelect={() => {
              setEditValue(label);
              // Defer so Radix finishes focus restoration before we focus the input
              setTimeout(() => setIsEditing(true), 0);
            }}
          >
            Rename
          </ContextMenu.Item>
          {!disableReset && labelIsCustom && (
            <ContextMenu.Item
              className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
              onSelect={() => onResetLabel(cwd)}
            >
              Reset to directory name
            </ContextMenu.Item>
          )}
          {worktreeDisabledReason !== undefined && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
              <ContextMenu.Item
                className={`px-2 py-1.5 rounded outline-none ${
                  worktreeDisabledReason === null
                    ? 'cursor-pointer focus:bg-fleet-surface-3 hover:bg-fleet-surface-3'
                    : 'cursor-default text-fleet-text-subtle'
                }`}
                disabled={worktreeDisabledReason !== null}
                onSelect={() => {
                  if (worktreeDisabledReason === null) onCreateWorktree?.();
                }}
              >
                <div className="flex items-center gap-2">
                  <GitBranch size={14} />
                  <span>Create Worktree</span>
                </div>
                {worktreeDisabledReason && (
                  <div className="text-xs text-fleet-text-subtle mt-0.5 ml-6">
                    {worktreeDisabledReason}
                  </div>
                )}
              </ContextMenu.Item>
            </>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
          <ContextMenu.Item
            className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-red-900/50 hover:bg-red-900/50 text-red-400"
            onSelect={onClose}
          >
            Close Tab
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
