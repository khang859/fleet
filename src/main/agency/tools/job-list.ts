import { jobDisplayId } from '../../../shared/agency';
import type { AgencyToolOutput } from '../../../shared/agency-tools';
import type { AgencyService } from '../index';

/** The repository's open jobs, each with how many questions wait on the client. */
export function jobList(agency: Pick<AgencyService, 'snapshot'>, repoId: string): AgencyToolOutput {
  const { jobs, questions } = agency.snapshot(repoId);
  if (jobs.length === 0) return { text: 'There are no open jobs.', summary: 'no jobs' };
  const lines = jobs.map((job) => {
    const waiting = questions.filter((q) => q.jobId === job.id && q.status === 'open').length;
    const asks =
      waiting === 0 ? 'nothing waiting on the client' : `${waiting} waiting on the client`;
    return `- ${jobDisplayId(job.id)} "${job.title}": ${job.state}, ${asks}`;
  });
  return {
    text: lines.join('\n'),
    summary: `${jobs.length} job${jobs.length === 1 ? '' : 's'}`
  };
}
