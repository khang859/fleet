import { jobDisplayId } from '../../../shared/agency';
import type { AgencyToolOutput, JobOpenArgs } from '../../../shared/agency-tools';
import type { AgencyService } from '../index';

/** Open a job from the lobby, on the client's default budget. */
export function jobOpen(
  agency: Pick<AgencyService, 'openJob'>,
  repoId: string,
  budgetUsd: number,
  args: JobOpenArgs
): AgencyToolOutput {
  const job = agency.openJob({ repoId, title: args.title, brief: args.brief, budgetUsd });
  const id = jobDisplayId(job.id);
  return {
    text: `Opened ${id} "${job.title}". It continues in its own tab, which carries this conversation over; tell the client in a line, and leave the rest of the job to that tab.`,
    summary: `opened ${id}`
  };
}
