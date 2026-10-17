import { questionDisplayId, type AdmiralThreadScope } from '../../../shared/agency';
import type { AgencyToolOutput, ClientFileProposeArgs } from '../../../shared/agency-tools';
import type { AgencyService } from '../index';

/** Put a client file change up as a card. A refused one is a sentence for the model. */
export function clientFilePropose(
  agency: Pick<AgencyService, 'proposeClientFile'>,
  scope: AdmiralThreadScope,
  args: ClientFileProposeArgs
): AgencyToolOutput {
  const out = agency.proposeClientFile(scope, {
    reason: args.reason,
    proposal: {
      add: (args.add ?? []).map((a) => ({ text: a.text, replaces: a.replaces ?? null })),
      remove: args.remove ?? []
    }
  });
  if (!out.ok) return { text: `Not proposed: ${out.reason}`, summary: 'not proposed' };
  const id = questionDisplayId(out.question.id);
  return {
    text: `${id} is up for the client. Nothing is written until they approve; their answer arrives as a wakeup.`,
    summary: `asked ${id}`
  };
}
