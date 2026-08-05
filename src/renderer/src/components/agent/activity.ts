import type { AgentMessage } from '../../../../shared/agent-types';

/**
 * What the agent is doing right now, as far as the screen can honestly tell.
 *
 * Deliberately not a rotating list of whimsical verbs. The word is worth
 * animating only if it says something true, and these four are the only
 * distinctions the pane can actually observe: nothing back yet, reasoning
 * arriving, answer arriving, or folding the transcript up.
 */
export type AgentPhase = 'waiting' | 'reasoning' | 'writing' | 'tooling' | 'compacting';

export const PHASE_LABEL: Record<AgentPhase, string> = {
  waiting: 'Thinking',
  reasoning: 'Reasoning',
  writing: 'Writing',
  tooling: 'Working',
  compacting: 'Compacting context'
};

/**
 * The phase a turn is in, read off the message being streamed into.
 *
 * `compacting` is not derivable from the transcript - it is the one case where
 * the work is not writing into any message - so it is passed in.
 *
 * A running tool outranks whatever the model wrote on its way to asking for
 * it: the text has stopped, and the wait is now the tool's.
 */
export function agentPhase(last: AgentMessage | undefined, compacting: boolean): AgentPhase {
  if (compacting) return 'compacting';
  if (last?.role !== 'assistant') return 'waiting';
  if (last.toolCalls.some((c) => c.result === null && c.error === null)) return 'tooling';
  if (last.content !== '') return 'writing';
  return last.reasoning === '' ? 'waiting' : 'reasoning';
}

/**
 * Whether the label should shimmer. Only while there is nothing else moving:
 * once text is streaming in, the text is the animation, and two things moving
 * for one event is one too many. A running tool has its own shimmering row,
 * which is the more specific of the two, so this one stays still.
 */
export function phaseShimmers(phase: AgentPhase): boolean {
  return phase === 'waiting' || phase === 'compacting';
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
