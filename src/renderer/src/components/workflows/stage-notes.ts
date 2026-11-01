import type { WorkflowDef } from '../../../../shared/workflows';

export function finishNote(def: WorkflowDef): string {
  const action = def.finish?.action;
  if (action === 'open-pr') return 'Opens a pull request';
  if (action === 'post-pr') return 'Posts on the PR';
  return action === 'save-report' ? 'Saves a report' : 'Shows the report';
}
