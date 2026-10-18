import type { AdmiralThreadScope } from '../../../shared/agency';
import type { PlanIssue } from '../../../shared/agency-jobs';
import { diffLine, diffPlans } from '../../../shared/agency-plan';
import type { AgencyToolOutput, JobPlanArgs } from '../../../shared/agency-tools';
import type { JobsService } from '../jobs';

/** The token a transcript row carries so the pane can find the plan card. */
export function planToken(versionId: number): string {
  return `plan#${versionId}`;
}

/** What the pre-approval check found, for the model to act on. */
function checkLines(issues: readonly PlanIssue[]): string {
  const of = (severity: PlanIssue['severity']): string[] =>
    issues.filter((i) => i.severity === severity).map((i) => i.text);
  const blocks = of('block');
  const warns = of('warn');
  const accepts = of('accept');
  return [
    blocks.length > 0
      ? `\n\nBlocking, so the client cannot approve it yet: ${blocks.join(' ')} Propose a new version that fixes these.`
      : '',
    warns.length > 0 ? `\n\nWarnings: ${warns.join(' ')}` : '',
    accepts.length > 0 ? `\n\nThe client accepts these to approve: ${accepts.join(' ')}` : ''
  ].join('');
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
  const dropped =
    result.dropped.length > 0
      ? `\n\nLeft out of \`uses\`, as no saved line has these ids: ${result.dropped.join(', ')}.`
      : '';
  if (result.autoStarted) {
    return {
      text: `Plan v${version.version} started on its own: the project's trust level lets Fleet start a plan this small, and it passed every check. Hire for the steps that may start now with crew_hire, and tell the client in a line what you started and why. They can still stop or change it from its card.${dropped}`,
      summary: `started plan v${version.version} on its own ${planToken(version.id)}`
    };
  }
  const changes = diffPlans(approved, version.plan).map(diffLine);
  const what =
    changes.length === 0
      ? `Plan v${version.version}`
      : `Plan change v${version.version} (${changes.join('; ')})`;
  return {
    text: `${what} is up for the client as a card. Their decision arrives as a wakeup. Nothing starts until they approve; tell them in a line what you propose and why.${checkLines(version.checks.issues)}${dropped}`,
    summary: `proposed plan v${version.version} ${planToken(version.id)}`
  };
}
