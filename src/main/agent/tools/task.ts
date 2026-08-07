import type { AgentToolContext, AgentToolResult, TaskArgs } from '../../../shared/agent-tools';

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

  const task = await ctx.dispatchTask({
    agent: definition.name,
    prompt: args.prompt,
    tools: args.tools ?? null
  });

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
