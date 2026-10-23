import type { AgencyToolOutput, JobUpdateArgs } from '../../../shared/agency-tools';
import type { JobsService } from '../jobs';

/** Move a step of the plan in force, or note its progress. */
export function jobUpdate(
  jobs: Pick<JobsService, 'updateStep'>,
  jobId: number,
  args: JobUpdateArgs
): AgencyToolOutput {
  const result = jobs.updateStep(jobId, args);
  const summary = !result.ok
    ? `${args.step} not moved`
    : args.status === undefined
      ? `noted ${args.step}`
      : `${args.step} ${args.status}`;
  return { text: result.text, summary };
}
