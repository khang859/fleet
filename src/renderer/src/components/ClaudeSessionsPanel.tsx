import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronRight } from 'lucide-react';
import { SectionHeader } from './SidebarSectionHeader';
import { useSidebarSectionsStore } from '../store/sidebar-sections-store';
import { useWorkspaceStore, collectPaneLeafs } from '../store/workspace-store';
import {
  useClaudeSessionsStore,
  contextPercent,
  foldSessions,
  formatCost,
  formatPhaseAge,
  sessionUrgency,
  sortSessions,
  type FoldedSessions,
  type SessionUrgency
} from '../store/claude-sessions-store';
import { openSettings } from '../store/settings-nav-store';
import { focusPane } from '../lib/focus-pane';
import type { ClaudeSessionView, ClaudeSessionsSnapshot } from '../../../shared/claude-sessions';
import type { Workspace } from '../../../shared/types';

/**
 * Where a pane sits, for naming its row. `pane` names the pane within a split
 * tab, and is null when the tab has only the one pane.
 */
type PanePlace = { tab: string; pane: string | null; workspaceLabel: string | null };

function placesOf(current: Workspace, background: Map<string, Workspace>): Map<string, PanePlace> {
  const places = new Map<string, PanePlace>();
  const add = (ws: Workspace, workspaceLabel: string | null): void => {
    for (const tab of ws.tabs) {
      const leafs = collectPaneLeafs(tab.splitRoot);
      leafs.forEach((leaf, i) => {
        // A split tab can hold several sessions: tell them apart by the name the
        // user gave the pane, or else by its position in the tab.
        const paneName = leaf.labelIsCustom && leaf.label ? leaf.label : `pane ${i + 1}`;
        places.set(leaf.id, {
          tab: tab.label,
          pane: leafs.length > 1 ? paneName : null,
          workspaceLabel
        });
      });
    }
  };
  add(current, null);
  for (const ws of background.values()) add(ws, ws.label);
  return places;
}

/** The current time, refreshed each second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const DOT: Record<SessionUrgency, string> = {
  needsYou: 'bg-amber-400 animate-pulse',
  working: 'bg-blue-400',
  ready: 'border-[1.5px] border-green-500 bg-transparent',
  idle: 'border-[1.5px] border-fleet-text-subtle bg-transparent'
};

/** One short word, so it never crowds out the row's label; the tooltip has more. */
function statusText(session: ClaudeSessionView, urgency: SessionUrgency): string {
  if (session.phase === 'waitingForApproval') return 'approve';
  if (urgency === 'needsYou') return 'question';
  if (session.phase === 'compacting') return 'compacting';
  if (urgency === 'working') return 'working';
  if (urgency === 'ready') return 'ready';
  return 'starting';
}

const STATUS_CLASS: Record<SessionUrgency, string> = {
  needsYou: 'text-amber-700 dark:text-amber-400 font-medium',
  working: 'text-fleet-text-muted',
  ready: 'text-green-700 dark:text-green-400/80',
  idle: 'text-fleet-text-subtle'
};

function SessionRow({
  session,
  place,
  isActive,
  now
}: {
  session: ClaudeSessionView;
  place: PanePlace | undefined;
  isActive: boolean;
  now: number;
}): React.JSX.Element {
  const urgency = sessionUrgency(session);
  const tabLabel = place?.tab ?? session.projectName;
  const paneLabel = place?.pane ?? null;
  const label = paneLabel ? `${tabLabel} › ${paneLabel}` : tabLabel;
  const cost = session.usage.costUsd;
  const context = contextPercent(session);
  const branch = session.git?.branch;
  const needsYou = urgency === 'needsYou';
  const tool = session.pendingPermissions[0]?.tool.toolName;

  return (
    <button
      type="button"
      onClick={() => void focusPane(session.paneId)}
      title={[label, tool && `Wants to use ${tool}`, session.cwd].filter(Boolean).join('\n')}
      className={`w-full text-left flex flex-col gap-0.5 rounded-md px-2.5 py-1 border-l-2 transition-colors ${
        needsYou
          ? 'border-l-amber-400 bg-amber-400/10 hover:bg-amber-400/15'
          : isActive
            ? 'border-l-fleet-border-strong bg-fleet-surface-3'
            : 'border-l-transparent hover:bg-fleet-surface-2'
      }`}
    >
      <span className="flex w-full items-baseline gap-2 min-w-0">
        <span
          className={`inline-block h-2 w-2 shrink-0 self-center rounded-full ${DOT[urgency]}`}
          aria-hidden
        />
        {/* The tab name gives way first: the pane name is what tells a split tab's rows apart. */}
        <span
          className={`flex min-w-0 text-sm leading-tight ${isActive || needsYou ? 'text-fleet-text' : 'text-fleet-text-secondary'}`}
        >
          <span className="truncate">{tabLabel}</span>
          {paneLabel && <span className="shrink-0 whitespace-pre"> › {paneLabel}</span>}
        </span>
        <span className={`ml-auto shrink-0 text-[11px] leading-tight ${STATUS_CLASS[urgency]}`}>
          {statusText(session, urgency)}
          <span className="fleet-tnum text-fleet-text-subtle font-normal">
            {' '}
            {formatPhaseAge(now - session.phaseSince)}
          </span>
        </span>
      </span>
      <span className="flex w-full items-baseline gap-1.5 min-w-0 pl-4 text-[11px] leading-tight text-fleet-text-muted">
        {place?.workspaceLabel && (
          <span className="shrink-0 max-w-[40%] truncate text-fleet-text-subtle">
            {place.workspaceLabel}
          </span>
        )}
        <span className="min-w-0 truncate text-teal-700 dark:text-teal-400/70">
          {branch ?? '-'}
        </span>
        <span className="ml-auto shrink-0 fleet-tnum" title="Estimated cost">
          {cost === null ? '$-' : formatCost(cost)}
        </span>
        <span
          className={`shrink-0 fleet-tnum ${context !== null && context >= 80 ? 'text-amber-700 dark:text-amber-400' : ''}`}
          title={
            context === null
              ? 'Context use not known yet'
              : `${session.usage.contextTokens?.toLocaleString()} of ${session.usage.contextLimit?.toLocaleString()} tokens`
          }
        >
          {context === null ? '-%' : `${context}%`}
        </span>
      </span>
    </button>
  );
}

/** `5 working · 9 ready`: the states of the sessions folded into one line. */
function foldedText(counts: FoldedSessions['counts']): string {
  return (['working', 'ready', 'idle'] as const)
    .filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${state}`)
    .join(' · ');
}

/**
 * Why the section cannot list sessions, and what fixes it; null when it can.
 * The sidebar is narrow: `detail` is shown clamped, and `tooltip` only on
 * hover, since the setting that `fix` opens explains the problem in full.
 */
function problemOf(
  snapshot: ClaudeSessionsSnapshot
): { text: string; detail?: string; tooltip?: string; fix?: string } | null {
  const { status, installProblems } = snapshot;
  if (status.state === 'off') {
    return { text: 'Session tracking is off.', fix: 'Turn on' };
  }
  if (status.state === 'unsupported') {
    return { text: 'Session tracking is not available on Windows yet.' };
  }
  if (status.state === 'failed') {
    return { text: 'Session tracking could not start.', detail: status.detail, fix: 'Settings' };
  }
  if (installProblems.length > 0) {
    const [first] = installProblems;
    const more = installProblems.length > 1 ? ` and ${installProblems.length - 1} more` : '';
    return {
      text: `Fleet could not add its hooks to ${folderName(first.configDir)}${more}.`,
      tooltip: first.detail,
      fix: 'Hook settings'
    };
  }
  return null;
}

/** The last part of a folder path, which is what tells config folders apart. */
function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  );
}

/**
 * The Claude Code sessions running in Fleet panes, most urgent first. Hidden
 * while tracking works and nothing runs; when tracking cannot work, it says
 * why and links to the setting that fixes it.
 */
export function ClaudeSessionsPanel(): React.JSX.Element | null {
  const snapshot = useClaudeSessionsStore((s) => s.snapshot);
  const collapsed = useSidebarSectionsStore((s) => s.collapsed.has('claude'));
  const toggle = useSidebarSectionsStore((s) => s.toggle);
  const { workspace, backgroundWorkspaces, activePaneId } = useWorkspaceStore(
    useShallow((s) => ({
      workspace: s.workspace,
      backgroundWorkspaces: s.backgroundWorkspaces,
      activePaneId: s.activePaneId
    }))
  );
  const places = useMemo(
    () => placesOf(workspace, backgroundWorkspaces),
    [workspace, backgroundWorkspaces]
  );
  const sessions = useMemo(() => sortSessions(snapshot?.sessions ?? []), [snapshot]);
  const folded = useMemo(() => foldSessions(sessions), [sessions]);
  const [showRest, setShowRest] = useState(false);
  const now = useNow(!collapsed && sessions.length > 0);

  const row = (session: ClaudeSessionView): React.JSX.Element => (
    <SessionRow
      key={session.sessionId}
      session={session}
      place={places.get(session.paneId)}
      isActive={session.paneId === activePaneId}
      now={now}
    />
  );

  // Folded, the rest open below the rows for sessions that need the user.
  const rows = !folded ? sessions : showRest ? [...folded.urgent, ...folded.rest] : folded.urgent;

  if (!snapshot) return null;
  const problem = problemOf(snapshot);
  if (!problem && sessions.length === 0) return null;
  const needYou = sessions.filter((s) => sessionUrgency(s) === 'needsYou').length;

  return (
    <div className="border-t border-fleet-border px-2 py-2 space-y-0.5">
      <SectionHeader label="Claude Code" collapsed={collapsed} onToggle={() => toggle('claude')}>
        {needYou > 0 ? (
          <span className="rounded bg-amber-400/15 px-1.5 py-px text-[10px] font-medium tabular-nums text-amber-700 dark:text-amber-400">
            {needYou} need{needYou === 1 ? 's' : ''} you
          </span>
        ) : (
          sessions.length > 0 && (
            <span className="text-[10px] font-medium tabular-nums text-fleet-text-subtle">
              {sessions.length}
            </span>
          )
        )}
      </SectionHeader>
      {!collapsed && problem && (
        <div className="px-2.5 py-1 text-[11px] leading-snug text-fleet-text-muted">
          <p title={problem.tooltip}>
            {problem.text}
            {problem.fix && (
              <>
                {' '}
                <button
                  type="button"
                  className="fleet-accent-text hover:underline"
                  onClick={() => openSettings('workspaces')}
                >
                  {problem.fix}
                </button>
              </>
            )}
          </p>
          {problem.detail && (
            <p
              className="mt-0.5 line-clamp-3 wrap-anywhere text-fleet-text-subtle"
              title={problem.detail}
            >
              {problem.detail}
            </p>
          )}
        </div>
      )}
      {!collapsed && rows.length > 0 && (
        <div className="max-h-[30vh] overflow-y-auto space-y-0.5">{rows.map(row)}</div>
      )}
      {/* Below the scrolling rows, so it stays under the pointer as they open. */}
      {!collapsed && folded && folded.rest.length > 0 && (
        <button
          type="button"
          onClick={() => setShowRest((shown) => !shown)}
          aria-expanded={showRest}
          className="w-full flex items-center gap-1.5 rounded-md border-l-2 border-l-transparent px-2.5 py-1 text-left text-[11px] leading-tight text-fleet-text-muted hover:bg-fleet-surface-2 hover:text-fleet-text-secondary transition-colors"
        >
          <ChevronRight
            size={12}
            aria-hidden
            className={`-ml-0.5 shrink-0 transition-transform ${showRest ? 'rotate-90' : ''}`}
          />
          <span className="fleet-tnum truncate">{foldedText(folded.counts)}</span>
        </button>
      )}
    </div>
  );
}
