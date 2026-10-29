import type { AdmiralThreadScope } from '../../../shared/agency';
import type { PlanIssue } from '../../../shared/agency-jobs';
import { diffLine, diffPlans } from '../../../shared/agency-plan';
import type { AgencyToolOutput, JobPlanArgs } from '../../../shared/agency-tools';
import type { JobsService } from '../jobs';

/** The token a transcript row carries so the pane can find the plan card. */
export function planToken(versionId: number): string {
  return `plan#${versionId}`;
}

/** What the check found beyond what stops a plan, for the model to act on. */
function checkLines(issues: readonly PlanIssue[]): string {
  const of = (severity: PlanIssue['severity']): string[] =>
    issues.filter((i) => i.severity === severity).map((i) => i.text);
  const warns = of('warn');
  const accepts = of('accept');
  return [
    warns.length > 0 ? `\n\nWarnings: ${warns.join(' ')}` : '',
    accepts.length > 0 ? `\n\nAccepted for you: ${accepts.join(' ')}` : ''
  ].join('');
}

/**
 * Record a plan version, which starts at once when it passes its checks. A
 * refused or held plan is a sentence for the model, so it can fix the plan
 * and send it again.
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
  const changes = diffPlans(approved, version.plan).map(diffLine);
  const what =
    changes.length === 0
      ? `Plan v${version.version}`
      : `Plan change v${version.version} (${changes.join('; ')})`;
  if (!result.started.ok) {
    return {
      text: `${what} did not start: ${result.started.reason} Send a new version that fixes it. If only the client can fix it, ask them with ask_client.${dropped}`,
      summary: `plan v${version.version} held ${planToken(version.id)}`
    };
  }
  return {
    text: `${what} started. Hire for the steps that may start now with crew_hire. Do not tell the client; they hear from you when the work is ready.${checkLines(version.checks.issues)}${dropped}`,
    summary: `started plan v${version.version} ${planToken(version.id)}`
  };
}
