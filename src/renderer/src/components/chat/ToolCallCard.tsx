import { useState } from 'react';
import type {
  PermissionOutcome,
  PermissionRequestPayload
} from '../../../../shared/chat-permissions';

type Props = {
  request: PermissionRequestPayload;
  /** Live stdout/stderr once a call is approved and running (Phase 2 feeds this). */
  output?: string;
  onDecide: (outcome: PermissionOutcome) => void;
};

/**
 * Collapsible card rendered inline in the message stream when a gated tool call
 * needs a decision. Shows the tool, the exact command, the cwd, any streamed
 * output, and the three approval actions. This is the shared approval surface
 * for every gated tool (Bash today, MCP tools later).
 */
export function ToolCallCard({ request, output, onDecide }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const [decided, setDecided] = useState<PermissionOutcome | null>(null);

  const decide = (outcome: PermissionOutcome): void => {
    setDecided(outcome);
    onDecide(outcome);
  };

  return (
    <div className="mx-4 my-2 overflow-hidden rounded-lg border border-fleet-border bg-fleet-surface-2 text-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-fleet-text"
      >
        <span className="text-fleet-text-muted">{expanded ? '▾' : '▸'}</span>
        <span className="font-medium">{request.tool}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fleet-text-secondary">
          {request.command}
        </code>
        {decided && (
          <span
            className={`shrink-0 text-xs ${decided === 'deny' ? 'text-red-400' : 'text-green-400'}`}
          >
            {decided === 'deny' ? 'Denied' : 'Allowed'}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-fleet-border px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-fleet-text">
            {request.command}
          </pre>
          {request.cwd && (
            <p className="mt-1 font-mono text-[11px] text-fleet-text-muted">cwd: {request.cwd}</p>
          )}
          {output !== undefined && output !== '' && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-fleet-surface-3 p-2 font-mono text-[11px] text-fleet-text-secondary">
              {output}
            </pre>
          )}

          {!decided && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => decide('allow-once')}
                className="rounded bg-fleet-accent/80 px-3 py-1 text-xs text-white hover:bg-fleet-accent"
              >
                Allow once
              </button>
              {request.rememberPrefix && (
                <button
                  type="button"
                  onClick={() => decide('allow-always')}
                  className="rounded bg-fleet-surface-3 px-3 py-1 text-xs text-fleet-text hover:bg-fleet-surface-2"
                >
                  Allow &amp; remember{' '}
                  <code className="font-mono text-fleet-text-secondary">
                    {request.rememberPrefix}
                  </code>
                </button>
              )}
              <button
                type="button"
                onClick={() => decide('deny')}
                className="rounded bg-fleet-surface-3 px-3 py-1 text-xs text-red-400 hover:bg-fleet-surface-2"
              >
                Deny
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
