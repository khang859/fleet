import type { AgentPermissionOutcome } from '../../../../shared/agent-types';
import { AgentPermissionRow } from './AgentPermissionRow';
import type { PendingTaskAsk } from './task-permissions';

/**
 * Every subagent question in the pane, pinned above the composer.
 *
 * Pinned rather than answered on the card, because a subagent's question is the
 * one in Fleet that does not stop the conversation. An ordinary question holds
 * the turn, so it is always at the end of the transcript and always on screen;
 * a subagent's does not, and the parent goes on writing above it until it has
 * scrolled out of the pane. With five running there can be several stranded up
 * there at once while the composer sits looking idle.
 *
 * The cards keep the context - which subagent, on what - and say they are
 * waiting. The answering happens here, in one place, so no question is ever
 * further than a glance from the composer, and there is never a second set of
 * buttons for the same question somewhere up the scroll.
 */
export function AgentTaskPermissions({
  pending,
  onDecide
}: {
  pending: PendingTaskAsk[];
  onDecide: (taskId: string, outcome: AgentPermissionOutcome) => void;
}): React.JSX.Element | null {
  if (pending.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-1.5 px-4 pb-2">
      <span className="text-[10px] tracking-wide text-fleet-text-subtle uppercase">
        {pending.length === 1 ? '1 subagent needs you' : `${pending.length} subagents need you`}
      </span>
      {/* Capped, because five of these is most of a pane. The count above says
          how many there are when the strip cannot show them all at once. */}
      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
        {pending.map(({ taskId, agent, ask }) => (
          <AgentPermissionRow
            key={taskId}
            ask={ask}
            by={agent}
            onDecide={(outcome) => onDecide(taskId, outcome)}
          />
        ))}
      </div>
    </div>
  );
}
