import type { AgentMessage, AgentPermissionAsk } from '../../../../shared/agent-types';

/** One subagent stopped on a command, and which one it is. */
export type PendingTaskAsk = { taskId: string; agent: string; ask: AgentPermissionAsk };

/**
 * The questions in this pane, each with the name of the subagent that asked it.
 *
 * The name is read back out of the transcript rather than carried on the
 * question, because the card on the row already has it and a second copy is a
 * second thing to keep true. A question whose card cannot be found is still
 * listed, under a name that says only that much: the one outcome worth ruling
 * out here is a subagent stopped on a command that nothing on screen offers to
 * answer.
 */
export function pendingTaskAsks(
  messages: AgentMessage[],
  asks: Record<string, AgentPermissionAsk>
): PendingTaskAsk[] {
  const pending = Object.entries(asks);
  // Before walking the transcript, which is every part of every message and is
  // walked on each render of a streaming turn.
  if (pending.length === 0) return [];

  const named = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool' && part.call.task !== null) {
        named.set(part.call.task.id, part.call.task.agent);
      }
    }
  }

  return pending.map(([taskId, ask]) => ({
    taskId,
    agent: named.get(taskId) ?? 'subagent',
    ask
  }));
}
