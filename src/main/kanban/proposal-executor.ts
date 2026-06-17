import type { KanbanCommands } from './kanban-commands';
import type { PmProposal } from '../../shared/kanban-types';
import type { KanbanReviewActionResult } from '../../shared/ipc-api';

/**
 * Deterministically run an approved proposal through KanbanCommands. Throws on
 * failure (caller marks the proposal 'failed' with the message). Review actions
 * return { ok, error } rather than throwing, so we normalize those to a throw.
 */
export function executeProposal(
  commands: KanbanCommands,
  proposal: Pick<PmProposal, 'kind' | 'targetId'>
): void {
  const { kind, targetId } = proposal;
  const expectOk = (r: KanbanReviewActionResult): void => {
    if (!r.ok) throw new Error(r.error ?? (r.conflict ? 'merge conflict' : 'action failed'));
  };
  switch (kind) {
    case 'merge_review_task':
      expectOk(commands.mergeReviewTask(targetId));
      return;
    case 'create_pr_for_task':
      expectOk(commands.createPrForTask(targetId));
      return;
    case 'accept_review_task':
      expectOk(commands.acceptReviewTask(targetId));
      return;
    case 'ship_feature':
      expectOk(commands.shipFeature(targetId));
      return;
    case 'complete_task':
      commands.complete(targetId, 'completed via PM proposal');
      return;
    case 'archive_task':
      commands.archive(targetId);
      return;
    case 'approve_spec':
      expectOk(commands.approveSpec(targetId));
      return;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown proposal kind: ${String(exhaustive)}`);
    }
  }
}
