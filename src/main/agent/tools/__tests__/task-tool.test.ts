import { describe, expect, it } from 'vitest';
import type { AgentToolContext, TaskArgs } from '../../../../shared/agent-tools';
import type { SubagentDefinition } from '../../../../shared/agent-subagents';
import { SubagentCapReached } from '../../subagents/manager';
import { runTask } from '../task';

/**
 * What the transcript says about a dispatch.
 *
 * The interesting case is the one that is not a failure. Fleet runs five
 * subagents at once across the whole app, and a turn that asks for a sixth is
 * doing the right thing - it keeps the five it has, carries on, and dispatches
 * the rest as slots come free. The row the user reads has to agree with that.
 */

const DEFINITION: SubagentDefinition = {
  name: 'review',
  description: 'reviews a change',
  systemPrompt: 'be thorough',
  tools: null,
  model: 'inherit',
  source: 'bundled',
  path: '/repo/.fleet/agents/review.md'
};

const ARGS: TaskArgs = { agent: 'review', prompt: 'review the permission gate' };

/** A context whose dispatcher answers however the test needs it to. */
function context(dispatch: AgentToolContext['dispatchTask']): AgentToolContext {
  return {
    cwd: '/repo',
    threadId: 'thread-1',
    signal: new AbortController().signal,
    handOff: () => {},
    approve: async () => Promise.resolve(true),
    wasRefused: () => false,
    generateImage: null,
    todos: { list: () => [], save: () => {} },
    mcp: null,
    dispatchTask: dispatch,
    findSubagent: (name) => (name === DEFINITION.name ? DEFINITION : null),
    findSkill: null
  };
}

const CAP = new SubagentCapReached(
  '5 subagents are already running, which is as many as Fleet will run at once. Wait for one to report back and dispatch this again.'
);

describe('runTask, when the parallel cap turns a dispatch away', () => {
  it('answers rather than throwing, so the row is not drawn as a failure', async () => {
    const result = await runTask(
      ARGS,
      context(async () => Promise.reject(CAP))
    );

    expect(result.summary).toBe('waiting for a slot');
    // No task, because none started - so no report will ever land on this row.
    expect(result.task).toBeUndefined();
  });

  /*
   * The half that must not change. The sentence is already clear and already
   * produces the right behaviour; all that changes is how the row is drawn.
   */
  it('hands the model the same sentence it always got', async () => {
    const result = await runTask(
      ARGS,
      context(async () => Promise.reject(CAP))
    );

    expect(result.text).toBe(CAP.message);
  });

  /*
   * Told apart by type, not by sentence. Anything else the dispatcher throws is
   * a real failure and still reads as one - a subagent that will never exist is
   * not a subagent that is not free yet.
   */
  it('still fails on anything that is not the cap', async () => {
    await expect(
      runTask(
        ARGS,
        context(async () => Promise.reject(new Error('the definitions folder is unreadable')))
      )
    ).rejects.toThrow('the definitions folder is unreadable');
  });

  it('reports an ordinary dispatch as running, as before', async () => {
    const result = await runTask(
      ARGS,
      context(async () =>
        Promise.resolve({
          id: 'task-1',
          agent: 'review',
          prompt: ARGS.prompt,
          status: 'running' as const,
          summary: null
        })
      )
    );

    expect(result.summary).toBe('running');
    expect(result.task?.id).toBe('task-1');
  });
});
