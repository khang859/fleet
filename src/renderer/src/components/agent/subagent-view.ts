import type { AgentMessage, AgentPermissionAsk } from '../../../../shared/agent-types';
import type { AgentTaskInfo } from '../../../../shared/agent-tools';
import { fitsSideColumn } from './side-column';

/**
 * What the running subagents look like, worked out apart from what draws them.
 *
 * The same shape as `todo-view`, and for the same reason: two places show this
 * list - a card in the column beside the conversation when the pane is wide, and
 * one chip above the composer when it is not - and neither should be the place
 * the rules live.
 */

/** One subagent still going, and everything either place needs to say about it. */
export type RunningSubagent = {
  taskId: string;
  agent: string;
  prompt: string;
  /**
   * What it is doing right now, from its own tool events. `null` for one that
   * has not called anything yet, which is an honest state rather than a gap.
   */
  activity: string | null;
  /**
   * Whether it is stopped on a command. The question is answered in the strip
   * above the composer, so what this owes the user is only the fact that this
   * is the one that stopped - and that it is not, therefore, working.
   */
  asking: boolean;
};

/**
 * Every subagent the transcript has heard of, by task id.
 *
 * The dispatched subagents are written down in one place - on the tool call
 * that started each - so anything that needs a name or a prompt for a task id
 * reads it back out of there rather than being handed a copy. A second copy is
 * a second thing to keep true, and this one would have to be kept true across a
 * replay from disk as well as a live dispatch.
 */
export function taskIndex(messages: AgentMessage[]): Map<string, AgentTaskInfo> {
  const found = new Map<string, AgentTaskInfo>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool' && part.call.task !== null) {
        found.set(part.call.task.id, part.call.task);
      }
    }
  }
  return found;
}

/**
 * The subagents this pane has running, in the order they were dispatched.
 *
 * Which ones those are comes from `activity` rather than from the statuses in
 * the transcript: that map is the pane's live registry - seeded when a child
 * starts, dropped when its report lands, and rebuilt against main on reload -
 * so it is the one thing that cannot be showing a subagent that stopped while
 * the app was closed.
 *
 * Dispatch order rather than the map's, because the map is rebuilt on every
 * activity line and a list that reorders itself as five children report their
 * progress is a list that has to be re-read each time.
 */
export function runningSubagents(
  messages: AgentMessage[],
  activity: Record<string, string | null>,
  asks: Record<string, AgentPermissionAsk>
): RunningSubagent[] {
  const running = Object.keys(activity);
  // Before walking the transcript, which is every part of every message and is
  // walked on each render of a streaming turn.
  if (running.length === 0) return [];

  const known = taskIndex(messages);
  const ordered: RunningSubagent[] = [];
  const seen = new Set<string>();
  for (const [taskId, task] of known) {
    if (!(taskId in activity)) continue;
    seen.add(taskId);
    ordered.push({
      taskId,
      agent: task.agent,
      prompt: task.prompt,
      activity: activity[taskId] ?? null,
      asking: taskId in asks
    });
  }

  // A running child whose call is not in the transcript - the pane was given
  // another session while it was still going. It is listed under a name that
  // says only that much, because the outcome worth ruling out is a subagent
  // running with nothing on screen offering to stop it.
  for (const taskId of running) {
    if (seen.has(taskId)) continue;
    ordered.push({
      taskId,
      agent: 'subagent',
      prompt: '',
      activity: activity[taskId] ?? null,
      asking: taskId in asks
    });
  }
  return ordered;
}

/**
 * Whether the subagents get a card in the column.
 *
 * Only that something is running, and that there is room - no clause about the
 * turn, unlike the task list. A subagent outlives the turn that dispatched it
 * by design: the call returns as soon as the child starts and the report lands
 * minutes later, so an idle composer over a working subagent is the ordinary
 * case rather than a stale one, and it is exactly when a list of what is still
 * out there is worth having.
 */
export function showSubagentPanel(
  running: RunningSubagent[],
  pane: {
    width: number | null;
    /** Whether the column is up now, which is what the two widths are about. */
    shown: boolean;
  }
): boolean {
  if (running.length === 0) return false;
  return fitsSideColumn(pane.width, pane.shown);
}
