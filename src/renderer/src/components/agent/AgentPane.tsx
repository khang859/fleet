import { useState } from 'react';
import { Bot, SlidersHorizontal } from 'lucide-react';
import { shortenPath } from '../../lib/shorten-path';
import { AgentSettingsPanel } from './settings/AgentSettingsPanel';

type AgentView = 'agent' | 'settings';

const TABS = [
  { value: 'agent', label: 'Agent', Icon: Bot },
  { value: 'settings', label: 'Settings', Icon: SlidersHorizontal }
] as const satisfies ReadonlyArray<{ value: AgentView; label: string; Icon: typeof Bot }>;

/**
 * Native agent pane. The agent view is still a placeholder; the settings view
 * is live and app-wide, since every agent pane runs on the same provider and
 * models and differs only in the folder it is rooted in.
 */
export function AgentPane({ cwd }: { cwd: string }): React.JSX.Element {
  const [view, setView] = useState<AgentView>('agent');

  return (
    <div className="flex h-full w-full flex-col bg-fleet-bg">
      <AgentTabs value={view} onChange={setView} />
      {view === 'agent' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
          <span className="text-sm font-medium uppercase tracking-[0.3em] text-fleet-text-subtle">
            Agent
          </span>
          <span className="max-w-full truncate px-4 text-xs text-fleet-text-subtle/70">
            {shortenPath(cwd)}
          </span>
        </div>
      ) : (
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
