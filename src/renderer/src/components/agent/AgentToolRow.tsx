import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AgentToolCall } from '../../../../shared/agent-tools';
import { toolLabel, toolStatus } from './tool-label';

/**
 * One tool call, on one line.
 *
 * The agent reads a lot of files to answer one question, and every product
 * that shows that has converged on the same row: a verb, the thing it acted
 * on, and how much came back. The output itself is behind a disclosure because
 * it is the model's input, not the user's - what the user needs from it is
 * confidence that the agent looked at the right file, and that is the target,
 * not the 200 lines it got.
 *
 * The exception is a call that failed. Then the row is the only place the
 * reason exists, so the row says so plainly and the disclosure holds the
 * reason rather than a result.
 */
export function AgentToolRow({ call }: { call: AgentToolCall }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const status = toolStatus(call);
  const { verb, target } = toolLabel(call);
  const body = call.error ?? call.result;

  const label = (
    <>
      <span className="shrink-0">{verb}</span>
      {target !== '' && <span className="truncate font-mono text-[11px]">{target}</span>}
    </>
  );

  if (status === 'running') {
    return (
      <div className="flex items-center gap-1.5 pl-[18px] text-xs">
        <span className="fleet-shimmer-text flex min-w-0 items-center gap-1.5">{label}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        {label}
        <span
          className={`ml-auto shrink-0 pl-2 ${
            status === 'failed' ? 'text-amber-400/90' : 'text-fleet-text-subtle'
          }`}
        >
          {status === 'failed' ? 'failed' : call.summary}
        </span>
      </button>
      {open && body !== null && (
        <pre className="max-h-64 overflow-auto border-l-2 border-fleet-border pl-3 text-[11px] leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
          {body}
        </pre>
      )}
    </div>
  );
}
