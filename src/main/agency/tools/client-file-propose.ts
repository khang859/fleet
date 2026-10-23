import type { AdmiralThreadScope } from '../../../shared/agency';
import type { AgencyToolOutput, ClientFileProposeArgs } from '../../../shared/agency-tools';
import type { AgencyService } from '../index';

/** Write a client file change at once. A refused one is a sentence for the model. */
export function clientFilePropose(
  agency: Pick<AgencyService, 'learnClientLines'>,
  scope: AdmiralThreadScope,
  args: ClientFileProposeArgs
): AgencyToolOutput {
  const out = agency.learnClientLines(scope, {
    add: (args.add ?? []).map((a) => ({ text: a.text, replaces: a.replaces ?? null })),
    remove: args.remove ?? [],
    layer: args.layer
  });
  if (!out.ok) return { text: `Not written: ${out.reason}`, summary: 'not written' };
  return {
    text: 'Written. The client sees it in What the Admiral knows, where they can change or remove it.',
    summary: 'learned'
  };
}
