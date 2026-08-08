import type {
  AgentTaskInfo,
  AgentToolContext,
  AgentToolResult,
  TaskArgs
} from '../../../shared/agent-tools';
import { SubagentCapReached } from '../subagents/manager';

/**
 * Handing a job to a subagent.
 *
 * The only tool that answers before its work has started, let alone finished.
 * What comes back is a receipt - this was dispatched, carry on - and the report
 * lands on this same call some minutes later, once the child has written one.
 *
 * That shape is the whole feature. A blocking subagent would leave the composer
 * disabled and the user watching a spinner for something they cannot see, and
 * would make two subagents at once impossible, which is the case that is worth
 * having them for.
 */
/**
 * What the row says when the cap turned a dispatch away.
 *
 * Reads as a state rather than an outcome, because that is what it is - the
 * work was not refused, it was not started yet, and by the time the user reads
 * the row it has almost certainly been started since.
 */
const WAITING_FOR_SLOT = 'waiting for a slot';

export async function runTask(args: TaskArgs, ctx: AgentToolContext): Promise<AgentToolResult> {
  if (ctx.dispatchTask === null || ctx.findSubagent === null) {
    // Two ways to get here and they want different sentences, because one of
    // them the model can act on and the other it cannot: a subagent asking for
    // a subagent needs to be told to do the work itself, and a turn in a folder
    // with no definitions is a tool that should not have been offered at all.
    throw new Error('A subagent cannot start another subagent. Do this part of the work yourself.');
  }

  const definition = ctx.findSubagent(args.agent);
  if (definition === null) {
    throw new Error(`There is no subagent called "${args.agent}".`);
  }

  let task: AgentTaskInfo;
  try {
    task = await ctx.dispatchTask({
      agent: definition.name,
      prompt: args.prompt,
      tools: args.tools ?? null
    });
  } catch (err) {
    // Not a failure, and it must not be shown as one. Nothing went wrong: the
    // model asked for a sixth subagent while five were running, kept the five
    // it had, carried on with its own work, and dispatched this again once a
    // slot came free - which is the behaviour the cap is there to produce.
    // Thrown, it would land in the transcript as a red row in the middle of a
    // review, indistinguishable from a subagent that does not exist, and with
    // nothing to connect it to the retry that succeeded.
    //
    // The sentence the model reads is the manager's own, unchanged. It is
    // already clear and already produces the right behaviour; only how the row
    // is drawn changes.
    if (!(err instanceof SubagentCapReached)) throw err;
    return { text: err.message, summary: WAITING_FOR_SLOT };
  }

  return {
    // Written so a model reading it two rounds later does not go looking for a
    // result that has not been written yet. The last sentence is the one that
    // matters: without it, models fill the wait with `bash sleep`.
    text: [
      `The ${definition.name} subagent has started, and is running in the background.`,
      '',
      'Its report will appear as the result of this call on a later turn. Nothing further is needed from you to collect it, and there is no way to hurry it up - carry on with whatever else you can do meanwhile, or, if there is nothing, say what you are waiting for and stop.'
    ].join('\n'),
    summary: 'running',
    task
  };
}
