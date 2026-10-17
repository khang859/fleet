import { questionDisplayId, type AdmiralThreadScope } from '../../../shared/agency';
import type { AgencyToolOutput, AskClientArgs } from '../../../shared/agency-tools';
import type { AgencyService } from '../index';

/**
 * Put a question to the client and return at once. The model numbers options
 * from 1, as the card does; the store keeps indexes.
 */
export function askClient(
  agency: Pick<AgencyService, 'ask'>,
  scope: AdmiralThreadScope,
  args: AskClientArgs
): AgencyToolOutput {
  const dep = args.depends_on ?? null;
  const question = agency.ask(scope, {
    question: args.question,
    context: args.context,
    options: args.options,
    recommended: args.recommended === undefined ? null : args.recommended - 1,
    dependsOn: dep === null ? null : { question: dep.question, option: dep.option - 1 },
    step: args.step ?? null
  });
  const id = questionDisplayId(question.id);
  if (question.status === 'hidden' && dep !== null) {
    return {
      text: `${id} is held until ${questionDisplayId(dep.question)} is answered with option ${dep.option}. It shows then, and is withdrawn if another option is picked.`,
      summary: `${id} held`
    };
  }
  if (question.status === 'withdrawn') {
    return {
      text: `${id} was not shown: ${question.withdrawnReason ?? 'the question it depends on is settled'}.`,
      summary: `${id} not shown`
    };
  }
  return {
    text: `${id} is up for the client. Their answer arrives as a wakeup; carry on with what does not depend on it.`,
    summary: `asked ${id}`
  };
}
