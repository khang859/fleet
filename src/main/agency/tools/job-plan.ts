import type { AdmiralThreadScope } from '../../../shared/agency';
import { diffLine, diffPlans } from '../../../shared/agency-plan';
import type { AgencyToolOutput, JobPlanArgs } from '../../../shared/agency-tools';
import type { JobsService } from '../jobs';

/** The token a transcript row carries so the pane can find the plan card. */
export function planToken(versionId: number): string {
  return `plan#${versionId}`;
}

/**
 * Put a plan version up for the client and return at once. A refused plan is
 * a sentence for the model, so it can fix the plan and send it again.
 */
export async function jobPlan(
  jobs: Pick<JobsService, 'propose' | 'approvedPlan'>,
  scope: AdmiralThreadScope & { jobId: number },
  args: JobPlanArgs
): Promise<AgencyToolOutput> {
  const approved = jobs.approvedPlan(scope.jobId);
  const result = await jobs.propose(scope.jobId, args);
  if (!result.ok)
    return { text: `The plan was not proposed: ${result.error}`, summary: 'plan refused' };
  const { version } = result;
  const changes = diffPlans(approved, version.plan).map(diffLine);
  const what =
    changes.length === 0
      ? `Plan v${version.version}`
      : `Plan change v${version.version} (${changes.join('; ')})`;
  return {
    text: `${what} is up for the client as a card. Their decision arrives as a wakeup. Nothing starts until they approve; tell them in a line what you propose and why.`,
    summary: `proposed plan v${version.version} ${planToken(version.id)}`
  };
}
