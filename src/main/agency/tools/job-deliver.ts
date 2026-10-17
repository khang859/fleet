import type { AgencyToolOutput, JobDeliverArgs } from '../../../shared/agency-tools';
import type { ResultsService } from '../results';

/** Hand back a result of a step as a card. A refused one is a sentence for the model. */
export async function jobDeliver(
  results: Pick<ResultsService, 'deliver'>,
  jobId: number,
  args: JobDeliverArgs
): Promise<AgencyToolOutput> {
  const out = await results.deliver(jobId, args);
  const token = /result#\d+/.exec(out.text)?.[0];
  return {
    text: out.text,
    summary: out.ok && token !== undefined ? `delivered ${args.kind} ${token}` : 'not delivered'
  };
}
