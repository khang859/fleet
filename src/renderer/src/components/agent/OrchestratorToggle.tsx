import { Radar } from 'lucide-react';
import { isOrchestratorPane, useWorkspaceStore } from '../../store/workspace-store';

/**
 * Orchestrator mode for one agent pane: whether its turns get the fleet tools
 * that read, and later prompt, the Claude Code sessions running in Fleet.
 *
 * In the composer beside the permissions label because both say what the next
 * message may do, and per pane rather than a setting because one pane looking
 * after the others is the point - every pane doing it would pay the tools'
 * cost on every turn for nothing.
 */
export function OrchestratorToggle({
  paneId,
  disabled
}: {
  paneId: string;
  disabled: boolean;
}): React.JSX.Element {
  const on = useWorkspaceStore((s) => isOrchestratorPane(s, paneId));
  const setOrchestrator = useWorkspaceStore((s) => s.setAgentOrchestrator);
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      aria-label="Orchestrator mode"
      title={
        on
          ? 'Orchestrator mode is on: this agent can see the Claude Code sessions in your other panes. Click to turn it off.'
          : 'Orchestrator mode: let this agent see the Claude Code sessions in your other panes.'
      }
      onClick={() => setOrchestrator(paneId, !on)}
      className={`flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[11px] font-medium transition-colors hover:bg-fleet-surface-2 disabled:cursor-not-allowed disabled:opacity-40 focus-ring ${on ? 'fleet-accent-text' : 'text-fleet-text-muted hover:text-fleet-text'}`}
    >
      <Radar size={14} />
      {on && 'Orchestrator'}
    </button>
  );
}

/** The pane's mark that it is in orchestrator mode, beside its view switcher. */
export function OrchestratorBadge({ paneId }: { paneId: string }): React.JSX.Element | null {
  const on = useWorkspaceStore((s) => isOrchestratorPane(s, paneId));
  if (!on) return null;
  return (
    <span
      title="Orchestrator mode: this agent can see the Claude Code sessions in your other panes."
      className="flex h-6 items-center gap-1 rounded-md border border-fleet-border bg-fleet-glass-surface px-1.5 text-[10px] font-medium uppercase tracking-wide fleet-accent-text backdrop-blur-md"
    >
      <Radar size={11} />
      Orchestrator
    </span>
  );
}
