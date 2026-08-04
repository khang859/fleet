/**
 * Native agent pane. Placeholder shell for now - it only claims the pane type
 * and the surface the agent UI will grow into.
 */
export function AgentPane(): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-fleet-surface-1">
      <span className="text-sm font-medium uppercase tracking-[0.3em] text-fleet-text-subtle">
        Agent
      </span>
    </div>
  );
}
