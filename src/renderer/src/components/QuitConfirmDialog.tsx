import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { QuitWorkItem } from '../../../shared/quit-confirm';
import { useNotificationStore } from '../store/notification-store';
import { useWorkspaceStore } from '../store/workspace-store';
import { findPaneLocation, paneLabel } from '../lib/palette-items';
import { PaneStatusGlyph } from './PaneStatusGlyph';
import { Overlay } from './Overlay';

/** A pane blocked on a question is the one most easily forgotten, so it leads. */
const URGENCY: Record<string, number> = {
  needs_me: 0,
  working: 1,
  subagent: 2,
  background: 3
};

function rankOf(item: QuitWorkItem): number {
  return URGENCY[item.state ?? item.kind] ?? 4;
}

const KIND_NOTE: Record<QuitWorkItem['kind'], string> = {
  pane: '',
  subagent: 'subagent',
  background: 'background'
};

/**
 * Confirmation for a close that would cut work off mid-run.
 *
 * Main decides whether to ask at all - it is the side that can see turns,
 * subagents and background commands - and sends what it knows. The panes are
 * added here, because only the renderer owns the tab and split tree that gives
 * a pane its name.
 *
 * Cancel holds focus, as in every other destructive confirmation in the app:
 * the safe choice is the one a reflexive Return or Escape lands on. If the two
 * sides disagree and nothing turns out to be running, the close is waved
 * through rather than showing an empty list.
 */
export function QuitConfirmDialog(): React.JSX.Element {
  const [pending, setPending] = useState<{ requestId: string; items: QuitWorkItem[] } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    return window.fleet.quit.onAsk(({ requestId, items }) => {
      const { activities } = useNotificationStore.getState();
      const ws = useWorkspaceStore.getState();
      // Background workspaces keep their panes running, so a command left
      // working in one is exactly the kind of thing this warning exists for.
      const tabs = [
        ...ws.workspace.tabs,
        ...[...ws.backgroundWorkspaces.values()].flatMap((w) => w.tabs)
      ];

      const panes: QuitWorkItem[] = [];
      for (const [paneId, record] of activities) {
        if (record.state !== 'working' && record.state !== 'needs_me') continue;
        const location = findPaneLocation(tabs, paneId);
        if (!location) continue;
        panes.push({ kind: 'pane', id: paneId, label: paneLabel(location), state: record.state });
      }

      const rows = [...panes, ...items].sort((a, b) => rankOf(a) - rankOf(b));
      if (rows.length === 0) {
        window.fleet.quit.decide(requestId, true);
        return;
      }
      setPending({ requestId, items: rows });
      requestAnimationFrame(() => cancelRef.current?.focus());
    });
  }, []);

  const decide = (proceed: boolean): void => {
    if (!pending) return;
    window.fleet.quit.decide(pending.requestId, proceed);
    setPending(null);
  };

  return (
    <Overlay open={pending !== null} onClose={() => decide(false)}>
      <div className="w-[420px] rounded-lg border border-fleet-border-strong bg-fleet-surface-2 p-4 shadow-xl">
        <div className="flex items-start gap-2.5">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fleet-text">Close Fleet?</h3>
            <p className="mt-1 text-xs text-fleet-text-muted">
              {pending?.items.length === 1
                ? 'One thing is still running. Closing stops it.'
                : `${pending?.items.length ?? 0} things are still running. Closing stops all of them.`}
            </p>
          </div>
        </div>

        <ul className="mt-3 max-h-[240px] divide-y divide-fleet-border overflow-y-auto rounded border border-fleet-border">
          {pending?.items.map((item) => (
            <li
              key={`${item.kind}:${item.id}`}
              className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
            >
              <PaneStatusGlyph state={item.state ?? 'working'} />
              <span className="truncate text-fleet-text-secondary">{item.label}</span>
              {KIND_NOTE[item.kind] !== '' && (
                <span className="ml-auto shrink-0 text-fleet-text-subtle">
                  {KIND_NOTE[item.kind]}
                </span>
              )}
              {item.state === 'needs_me' && (
                <span className="ml-auto shrink-0 text-amber-400">waiting on you</span>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            className="focus-ring rounded px-3 py-1 text-xs text-fleet-text-muted transition hover:bg-fleet-surface-3 hover:text-fleet-text active:scale-[0.97]"
            onClick={() => decide(false)}
          >
            Cancel
          </button>
          <button
            className="rounded bg-amber-700 px-3 py-1 text-xs text-white transition hover:bg-amber-600 active:scale-[0.97]"
            onClick={() => decide(true)}
          >
            Close anyway
          </button>
        </div>
      </div>
    </Overlay>
  );
}
