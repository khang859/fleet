import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ActivityState } from '../../../shared/types';
import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';
import { findPaneLocation, paneLabel } from '../lib/palette-items';
import { Overlay } from './Overlay';
import { PaneStatusGlyph } from './PaneStatusGlyph';

type AgentOverviewProps = {
  isOpen: boolean;
  onClose: () => void;
};

type Row = {
  paneId: string;
  tabId: string;
  label: string;
  branch?: string;
  state: ActivityState;
};

// Sort order: needs-input and failures never auto-hide and float to the top;
// `done` is the only bucket that collapses.
const URGENCY: Record<ActivityState, number> = {
  needs_me: 0,
  error: 1,
  working: 2,
  idle: 3,
  done: 4
};

const COLLAPSE_DONE_AFTER = 3;

export function AgentOverview({ isOpen, onClose }: AgentOverviewProps): React.JSX.Element | null {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showAllDone, setShowAllDone] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const tabs = useWorkspaceStore((s) => s.workspace.tabs);
  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const activities = useNotificationStore((s) => s.activities);

  useEffect(() => {
    if (isOpen) setShowAllDone(false);
  }, [isOpen]);

  // Every terminal pane across every tab that the activity tracker knows
  // about - non-terminal panes (file/image/pdf) have no ActivityState and
  // aren't "agents", so they're excluded rather than shown as fake-idle.
  const rows = useMemo<Row[]>(() => {
    if (!isOpen) return [];
    const out: Row[] = [];
    for (const tab of tabs) {
      for (const paneId of collectPaneIds(tab.splitRoot)) {
        const state = activities.get(paneId)?.state;
        if (!state) continue;
        const loc = findPaneLocation(tabs, paneId);
        if (!loc) continue;
        out.push({
          paneId,
          tabId: tab.id,
          label: paneLabel(loc),
          branch: tab.worktreeBranch,
          state
        });
      }
    }
    return out.sort((a, b) => URGENCY[a.state] - URGENCY[b.state]);
  }, [isOpen, tabs, activities]);

  const doneRows = rows.filter((r) => r.state === 'done');
  const hiddenDoneCount = showAllDone ? 0 : Math.max(0, doneRows.length - COLLAPSE_DONE_AFTER);
  const visibleRows = showAllDone
    ? rows
    : rows.filter((r) => r.state !== 'done').concat(doneRows.slice(0, COLLAPSE_DONE_AFTER));

  useEffect(() => {
    setSelectedIndex(0);
  }, [visibleRows.length]);

  useEffect(() => {
    const child = listRef.current?.children[selectedIndex];
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const jumpTo = useCallback(
    (row: Row) => {
      const ws = useWorkspaceStore.getState();
      ws.setActiveTab(row.tabId);
      ws.setActivePane(row.paneId);
      onClose();
      requestAnimationFrame(() => {
        document.dispatchEvent(
          new CustomEvent('fleet:refocus-pane', { detail: { paneId: row.paneId } })
        );
      });
    },
    [onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, visibleRows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visibleRows[selectedIndex]) jumpTo(visibleRows[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <Overlay
      open={isOpen}
      onClose={onClose}
      containerClassName="justify-center"
      panelClassName="mt-[12vh] w-[480px] max-h-[65vh] flex flex-col bg-fleet-surface-2 border border-fleet-border-strong rounded-lg shadow-xl overflow-hidden"
    >
      <div
        role="listbox"
        aria-label="Agents"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="flex flex-col outline-none"
      >
        <div className="px-3 py-2 border-b border-fleet-border flex items-center justify-between">
          <span className="text-xs font-medium text-fleet-text-secondary uppercase tracking-wide">
            Agents
          </span>
          <span className="text-[10px] text-fleet-text-subtle">{rows.length} panes</span>
        </div>
        <div ref={listRef} className="overflow-y-auto py-1">
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-sm text-fleet-text-muted text-center">
              No terminal panes open
            </div>
          ) : (
            visibleRows.map((row, i) => {
              const isFocusedPane = row.paneId === activePaneId;
              return (
                <button
                  key={row.paneId}
                  role="option"
                  aria-selected={i === selectedIndex}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors active:scale-[0.97] ${
                    i === selectedIndex ? 'bg-fleet-surface-3' : 'hover:bg-fleet-surface-3/60'
                  } ${isFocusedPane ? 'fleet-accent-ring-pane' : ''}`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => jumpTo(row)}
                >
                  <PaneStatusGlyph state={row.state} className="shrink-0" />
                  <span
                    className={`flex-1 truncate text-sm ${isFocusedPane ? 'text-fleet-text' : 'text-fleet-text-secondary'}`}
                  >
                    {row.label}
                  </span>
                  {row.branch && (
                    <span className="shrink-0 truncate max-w-[100px] text-[10px] text-teal-400/60">
                      {row.branch}
                    </span>
                  )}
                </button>
              );
            })
          )}
          {hiddenDoneCount > 0 && (
            <button
              className="w-full px-3 py-1.5 text-xs text-fleet-text-subtle hover:text-fleet-text-secondary text-center"
              onClick={() => setShowAllDone(true)}
            >
              … {hiddenDoneCount} more
            </button>
          )}
        </div>
        <div className="px-3 py-1.5 border-t border-fleet-border flex items-center gap-3 text-xs text-fleet-text-subtle">
          <span>↑↓ navigate</span>
          <span>↵ jump to pane</span>
          <span>esc dismiss</span>
        </div>
      </div>
    </Overlay>
  );
}
