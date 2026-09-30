import { CircleQuestionMark, Plug, SquareTerminal } from 'lucide-react';
import type { AgentPermissionAsk, AgentPermissionOutcome } from '../../../../shared/agent-types';

/** What the announcement says the agent is asking to run. */
function spoken(ask: AgentPermissionAsk): string {
  if (ask.fleet !== null) {
    switch (ask.fleet.action) {
      case 'send':
        return `send a prompt to the Claude Code session ${ask.fleet.target}`;
      case 'spawn':
        return `start a Claude Code session in ${ask.fleet.target}`;
      case 'permission':
        return `${ask.fleet.decision ?? 'answer'} a permission request from the Claude Code session ${ask.fleet.target}`;
    }
  }
  return ask.mcp === null ? ask.command : `${ask.mcp.tool} on the ${ask.mcp.server} server`;
}

/** The three answers' words: a fleet ask sends, starts or answers rather than runs. */
function answers(ask: AgentPermissionAsk): { once: string; always: string; no: string } {
  if (ask.fleet?.action === 'permission') {
    // Saying no leaves the request with the user, which is what the button says.
    return {
      once: ask.fleet.decision === 'deny' ? 'Deny it' : 'Allow it',
      always: '',
      no: 'Leave it to me'
    };
  }
  if (ask.fleet?.action === 'send') {
    return { once: 'Send once', always: 'Always for this session', no: "Don't send" };
  }
  if (ask.fleet?.action === 'spawn') {
    return { once: 'Start it', always: '', no: "Don't start" };
  }
  return { once: 'Run once', always: 'Always allow', no: "Don't run" };
}

/**
 * The arguments, on one line, for the user to glance at before agreeing.
 *
 * Re-printed compactly rather than shown as the model wrote them: the model
 * writes pretty JSON, and four lines of braces above the buttons pushes the
 * question itself out of view. Text that will not parse is shown as it came,
 * because a call about to run on arguments nobody can read is exactly the one
 * worth looking at twice.
 */
function args(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '{}') return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return JSON.stringify(parsed);
  } catch {
    return trimmed;
  }
}

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
  by = null,
  onDecide
}: {
  ask: AgentPermissionAsk;
  /**
   * Who is asking, where that is not obvious from where the row is drawn.
   *
   * A row inside the transcript is the agent's own, and saying so would be
   * telling the user which conversation they are looking at. The pinned strip
   * is the case this exists for: several subagents can be stopped on a command
   * at once, and there "who wants to run this" is half the question.
   */
  by?: string | null;
  /**
   * Takes the question's own id along with the answer. This row is what drew
   * the command the user read, so it is the only place that can say for certain
   * which question was answered.
   */
  onDecide: (outcome: AgentPermissionOutcome, requestId: string) => void;
}): React.JSX.Element {
  const words = answers(ask);
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
        {`${by === null ? 'The agent' : `The ${by} subagent`} is asking to ${ask.fleet === null ? 'run ' : ''}${spoken(ask)}.${
          ask.reason === null ? '' : ` ${ask.reason}`
        }`}
      </p>
      <div className="flex items-start gap-1.5">
        {ask.fleet !== null ? (
          <SquareTerminal
            size={13}
            aria-hidden="true"
            className="mt-px shrink-0 text-amber-700 dark:text-amber-400/90"
          />
        ) : ask.mcp === null ? (
          <CircleQuestionMark
            size={13}
            aria-hidden="true"
            className="mt-px shrink-0 text-amber-700 dark:text-amber-400/90"
          />
        ) : (
          <Plug
            size={13}
            aria-hidden="true"
            className="mt-px shrink-0 text-amber-700 dark:text-amber-400/90"
          />
        )}
        {by !== null && (
          // Before the command rather than above it, so a strip of these reads
          // down as a list of who wants what.
          <span className="shrink-0 text-[11px] leading-relaxed text-fleet-text-muted">{by}</span>
        )}
        <span className="max-h-32 overflow-y-auto font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-fleet-text">
          {ask.fleet !== null ? (
            <>
              {/* Where it goes, then the prompt exactly as it will be typed:
                  the prompt is the thing being agreed to. */}
              <span className="block font-sans text-fleet-text-subtle">
                {ask.fleet.action === 'send'
                  ? 'Prompt '
                  : ask.fleet.action === 'spawn'
                    ? 'New Claude Code session in '
                    : `${ask.fleet.decision === 'deny' ? 'Deny' : 'Allow'} a permission request from `}
                <span className="font-mono text-fleet-text">{ask.fleet.target}</span>
              </span>
              <span className="block break-normal wrap-break-word">{ask.fleet.prompt}</span>
            </>
          ) : ask.mcp === null ? (
            ask.command
          ) : (
            <>
              {ask.mcp.tool}
              {/* The server is what the user actually chose to connect, so it
                  is named rather than left implicit in the tool's name - which
                  is often generic enough to belong to any of them. */}
              <span className="text-fleet-text-subtle"> on {ask.mcp.server}</span>
              {args(ask.mcp.args) !== '' && (
                <span className="block text-fleet-text-subtle">{args(ask.mcp.args)}</span>
              )}
            </>
          )}
        </span>
      </div>
      {ask.reason !== null && <p className="text-[11px] text-fleet-text-subtle">{ask.reason}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onDecide('once', ask.requestId)}
          // Not `focus-ring`: that draws the accent directly against this
          // button's own accent fill, where it cannot be seen. The gap is what
          // makes it a ring rather than a slightly larger button.
          className="flex items-center gap-1.5 rounded-md fleet-accent-bg px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 focus-ring-offset"
        >
          {words.once}
          {/* The key that does this without reaching for the mouse. On the
              button rather than in a legend of its own, because the only place
              a shortcut is worth reading is next to what it does - and this is
              the only one of the three answers a key can give. */}
          <span aria-hidden="true" className="text-[10px] leading-none text-white/60">
            ⏎
          </span>
        </button>
        {ask.rule !== null && (
          <button
            type="button"
            onClick={() => onDecide('always', ask.requestId)}
            title={
              ask.fleet !== null
                ? `Let the agent send prompts to ${ask.fleet.target} without asking, until that session ends`
                : ask.mcp === null
                  ? `Always allow ${ask.rule}`
                  : `Always allow every tool on the ${ask.mcp.server} server`
            }
            className="flex min-w-0 max-w-full items-baseline gap-1 rounded-md bg-fleet-surface-3 px-2.5 py-1 text-[11px] font-medium text-fleet-text transition-colors hover:bg-fleet-surface-2 focus-ring"
          >
            {/* The command above is never shortened; the rule is derived text,
                and a rule long enough to break the row out of the card is one
                the button cannot usefully spell out anyway. */}
            <span className="shrink-0">{words.always}</span>
            {/* A server's rule is a wire-name glob, which is Fleet's plumbing.
                What the user agreed to is the server, so that is what the
                button says. A fleet grant is named by the button alone. */}
            {ask.fleet === null && (
              <span className={ask.mcp === null ? 'truncate font-mono' : 'truncate'}>
                {ask.mcp === null ? ask.rule : `${ask.mcp.server} tools`}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => onDecide('no', ask.requestId)}
          className="rounded-md px-2.5 py-1 text-[11px] font-medium text-fleet-text-subtle transition-colors hover:text-fleet-text focus-ring"
        >
          {words.no}
        </button>
      </div>
    </div>
  );
}
