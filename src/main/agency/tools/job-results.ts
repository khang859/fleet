import { jobDisplayId } from '../../../shared/agency';
import type { AgencyToolOutput, JobResultsArgs } from '../../../shared/agency-tools';
import { fence } from '../../../shared/fleet-tools';
import type { Findings } from '../findings';
import { renderFindings, renderResult, TOOL_FINDINGS_CHARS } from '../findings/render';
import { resultToken } from '../results';

/**
 * What a job of the repository found, open or ended. Crew wrote all of it, so
 * it comes back fenced as data. A job of another repository reads as unknown.
 */
export async function jobResults(
  findings: (jobId: number) => Promise<Findings | null>,
  repoId: string,
  args: JobResultsArgs
): Promise<AgencyToolOutput> {
  const id = jobDisplayId(args.job);
  const found = await findings(args.job);
  if (found?.job.repoId !== repoId) {
    return { text: `${id} is not a job of this project.`, summary: 'no such job' };
  }
  if (args.result === undefined) {
    return {
      text: fence(`${id} findings`, renderFindings(found, TOOL_FINDINGS_CHARS)),
      summary: `${found.results.length} result${found.results.length === 1 ? '' : 's'}`
    };
  }
  const token = resultToken(args.result);
  const item = found.results.find((r) => r.result.id === args.result);
  if (item === undefined) {
    return { text: `${token} is not a result of ${id}.`, summary: 'no such result' };
  }
  return {
    text: fence(`${id} ${token}`, renderResult(item, args.offset ?? 0)),
    summary:
      args.offset === undefined ? item.result.kind : `${item.result.kind} from ${args.offset}`
  };
}
