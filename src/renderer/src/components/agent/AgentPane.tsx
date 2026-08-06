import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Bot, History, SlidersHorizontal } from 'lucide-react';
import { AgentThread } from './AgentThread';
import { AgentSessionsTab } from './AgentSessionsTab';
import { AgentSettingsPanel } from './settings/AgentSettingsPanel';
import { useAgentStore } from '../../store/agent-store';

type AgentView = 'agent' | 'sessions' | 'settings';

/** The pane a `fleet:refocus-pane` event is about. */
const RefocusDetail = z.object({ paneId: z.string() });

const TABS = [
  { value: 'agent', label: 'Agent', Icon: Bot },
  { value: 'sessions', label: 'Sessions', Icon: History },
  { value: 'settings', label: 'Settings', Icon: SlidersHorizontal }
] as const satisfies ReadonlyArray<{ value: AgentView; label: string; Icon: typeof Bot }>;

/**
 * Native agent pane: a thread rooted in one folder, plus the settings every
 * agent pane shares - they run on the same provider and models and differ only
 * in the folder they work in.
 */
export function AgentPane({
  paneId,
  cwd,
  sessionId
}: {
  paneId: string;
  cwd: string;
  /** Absent on panes created before sessions existed; those stay in memory. */
  sessionId?: string;
}): React.JSX.Element {
  const [view, setView] = useState<AgentView>('agent');
  const loadModels = useAgentStore((s) => s.loadModels);
  const openSession = useAgentStore((s) => s.openSession);

  // Not only for the settings screen: the catalog carries the context limits,
  // and without them the pane cannot tell how full it is or compact on its own.
  // Loading it is idempotent and cached in main, so opening a pane is cheap.
  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // The thread this pane left behind. Reading it is what makes the pane the
  // same conversation after a restart rather than a new one in the same folder.
  useEffect(() => {
    if (sessionId === undefined) return;
    void openSession(paneId, sessionId, cwd);
  }, [openSession, paneId, sessionId, cwd]);

  // Sent here by something that wanted this pane looked at - a click on a
  // desktop notification, the palette's "needs you". Whatever it was asking
  // about is in the conversation, so that is what the pane comes back to.
  useEffect(() => {
    const handler = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail = RefocusDetail.safeParse(event.detail);
      if (!detail.success || detail.data.paneId !== paneId) return;
      setView('agent');
    };
    document.addEventListener('fleet:refocus-pane', handler);
    return () => document.removeEventListener('fleet:refocus-pane', handler);
  }, [paneId]);

  return (
    <div className="flex h-full w-full flex-col bg-fleet-bg">
      <AgentTabs value={view} onChange={setView} />
      {view === 'agent' && <AgentThread paneId={paneId} cwd={cwd} />}
      {view === 'sessions' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <AgentSessionsTab paneId={paneId} cwd={cwd} onResumed={() => setView('agent')} />
        </div>
      )}
      {view === 'settings' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AgentSettingsPanel />
        </div>
      )}
    </div>
  );
}

/**
 * The pane's own switcher, centered over the content it toggles. A pill track
 * rather than underlines: it reads as a control at any pane width, including
 * the narrow ones a vertical split produces.
 */
function AgentTabs({
  value,
  onChange
}: {
  value: AgentView;
  onChange: (view: AgentView) => void;
}): React.JSX.Element {
  const move = (delta: number): void => {
    const next =
      TABS[(TABS.findIndex((t) => t.value === value) + delta + TABS.length) % TABS.length];
    onChange(next.value);
  };

  return (
    <div className="flex shrink-0 justify-center px-3 pt-2.5 pb-1.5">
      <div
        role="tablist"
        aria-label="Agent pane view"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          move(e.key === 'ArrowRight' ? 1 : -1);
        }}
        className="flex items-center gap-0.5 rounded-lg border border-fleet-border bg-fleet-surface p-0.5"
      >
        {TABS.map(({ value: tab, label, Icon }) => {
          const selected = tab === value;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={selected}
              // Only the active tab is in the tab order; arrow keys move between
              // them, which is what a tablist is meant to do.
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors focus-ring ${
                selected
                  ? 'bg-fleet-surface-3 text-fleet-text'
                  : 'text-fleet-text-muted hover:text-fleet-text-secondary'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
