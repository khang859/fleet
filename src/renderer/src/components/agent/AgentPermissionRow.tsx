import { CircleQuestionMark } from 'lucide-react';
import type { AgentPermissionAsk, AgentPermissionOutcome } from '../../../../shared/agent-types';

/**
 * A command the agent cannot run without being told to.
 *
 * It takes the place of the tool row it belongs to rather than sitting beside
 * it, because until this is answered there is nothing else that row could be
 * saying. The command is shown whole and wrapped: it is the thing being agreed
 * to, and a truncated one asks the user to approve something they cannot read.
 * Whole, but not unbounded - a command long enough to fill the pane would push
 * the buttons that answer it off the bottom, so past a few lines it scrolls.
 *
 * "Always allow" is missing on the commands that always ask - the handful where
 * being wrong is expensive - so the answer there is only ever about this one
 * command, and never quietly about the next.
 */
export function AgentPermissionRow({
  ask,
  onDecide
}: {
  ask: AgentPermissionAsk;
  onDecide: (outcome: AgentPermissionOutcome) => void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Permission needed"
      className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5"
    >
      {/* The card is not announced by being drawn, and a question nobody hears
          is a turn that looks hung. Said once, politely, in full: the command
          on its own is not a question. */}
      <p role="status" className="sr-only">
        {`The agent is asking to run ${ask.command}.${ask.reason === null ? '' : ` ${ask.reason}`}`}
      </p>
      <div className="flex items-start gap-1.5">
        <CircleQuestionMark
          size={13}
          aria-hidden="true"
          className="mt-px shrink-0 text-amber-700 dark:text-amber-400/90"
        />
        <span className="max-h-32 overflow-y-auto font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-fleet-text">
          {ask.command}
        </span>
      </div>
      {ask.reason !== null && <p className="text-[11px] text-fleet-text-subtle">{ask.reason}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onDecide('once')}
          // Not `focus-ring`: that draws the accent directly against this
          // button's own accent fill, where it cannot be seen. The gap is what
          // makes it a ring rather than a slightly larger button.
          className="rounded-md fleet-accent-bg px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 focus-ring-offset"
        >
          Run once
        </button>
        {ask.rule !== null && (
          <button
            type="button"
            onClick={() => onDecide('always')}
            title={`Always allow ${ask.rule}`}
            className="flex min-w-0 max-w-full items-baseline gap-1 rounded-md bg-fleet-surface-3 px-2.5 py-1 text-[11px] font-medium text-fleet-text transition-colors hover:bg-fleet-surface-2 focus-ring"
          >
            {/* The command above is never shortened; the rule is derived text,
                and a rule long enough to break the row out of the card is one
                the button cannot usefully spell out anyway. */}
            <span className="shrink-0">Always allow</span>
            <span className="truncate font-mono">{ask.rule}</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => onDecide('no')}
          className="rounded-md px-2.5 py-1 text-[11px] font-medium text-fleet-text-subtle transition-colors hover:text-fleet-text focus-ring"
        >
          Don&apos;t run
        </button>
      </div>
    </div>
  );
}
