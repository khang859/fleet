import { shortenPath } from '../../lib/shorten-path';

/**
 * Native agent pane. Placeholder shell for now - it only claims the pane type
 * and the surface the agent UI will grow into, plus the folder it is rooted in.
 */
export function AgentPane({ cwd }: { cwd: string }): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-fleet-bg">
      <span className="text-sm font-medium uppercase tracking-[0.3em] text-fleet-text-subtle">
        Agent
      </span>
      <span className="max-w-full truncate px-4 text-xs text-fleet-text-subtle/70">
        {shortenPath(cwd)}
      </span>
    </div>
  );
}
