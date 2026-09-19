/**
 * What the agent is doing right now, as far as the screen can honestly tell.
 *
 * Deliberately not a rotating list of whimsical verbs. The word is worth
 * animating only if it says something true, and each of these is a wait the
 * pane can actually observe: nothing back yet, reasoning arriving, answer
 * arriving, a tool call being written, a command being checked, a tool
 * running, the transcript being folded up, or the user being asked.
 */
export type AgentPhase =
  | 'waiting'
  | 'reasoning'
  | 'writing'
  | 'drafting'
  | 'checking'
  | 'tooling'
  | 'compacting'
  | 'asking';

export const PHASE_LABEL: Record<AgentPhase, string> = {
  waiting: 'Thinking',
  reasoning: 'Reasoning',
  writing: 'Writing',
  drafting: 'Preparing tool call',
  checking: 'Checking permission',
  tooling: 'Working',
  compacting: 'Compacting context',
  asking: 'Waiting for you'
};

/**
 * The step a turn is on, and when it began. Set by the store as each stream
 * event arrives, so the clock beside the label counts this step rather than
 * the whole turn - "Thinking… 2:18" over a turn of forty quick steps reads as
 * one step stuck for two minutes.
 */
export type AgentStep = { phase: AgentPhase; since: number };

/**
 * The phase to show.
 *
 * `compacting` and `asking` are passed in rather than read off the step: a
 * compaction writes into no message, and the question may be a subagent's,
 * whose events are not this turn's.
 */
export function agentPhase(
  step: AgentStep | null,
  compacting: boolean,
  asking = false
): AgentPhase {
  // The most specific of the three, and the only one nothing else can end: the
  // turn is stopped on a question until the user answers it.
  if (asking) return 'asking';
  if (compacting) return 'compacting';
  return step?.phase ?? 'waiting';
}

/**
 * Whether the label should shimmer. Only while there is nothing else moving:
 * once text is streaming in, the text is the animation, and two things moving
 * for one event is one too many. A running tool has its own shimmering row,
 * which is the more specific of the two, so this one stays still.
 *
 * Reasoning is visible only in the first round, while its block is open. In a
 * later round the block is folded above the calls, so the label is the only
 * sign of it and shimmers like any other silent wait.
 */
export function phaseShimmers(phase: AgentPhase, reasoningShown = false): boolean {
  if (phase === 'reasoning') return !reasoningShown;
  return (
    phase === 'waiting' || phase === 'compacting' || phase === 'drafting' || phase === 'checking'
  );
}

/**
 * The line a finished reasoning block collapses to.
 *
 * Anything under a second gets no number: "Thought for 0s" reads as a broken
 * clock rather than as a fast answer, and the duration is only worth showing
 * when it is long enough to have been worth waiting for.
 */
export function reasoningLabel(durationMs: number | null): string {
  if (durationMs === null || durationMs < 1000) return 'Thought';
  return `Thought for ${formatElapsed(durationMs)}`;
}

/** Elapsed time as a clock: `9s`, `45s`, `1:12`, `10:05`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
