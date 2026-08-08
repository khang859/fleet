import { describe, expect, it } from 'vitest';
import type { SubagentDefinition } from '../../../../shared/agent-subagents';
import { SubagentManager, type TaskOutcome, type TaskRun } from '../manager';

/**
 * What the registry says about the subagents that are still out.
 *
 * The reports themselves are the round loop's business and are tested with it.
 * What is checked here is only who the manager says is running and to whom -
 * which is what a parent's next round is built from, and the one thing a wrong
 * answer would put in front of the model as fact.
 */

const DEFINITION: SubagentDefinition = {
  name: 'explore',
  description: 'looks things up',
  systemPrompt: 'be brief',
  tools: null,
  model: 'inherit',
  source: 'bundled',
  path: '/repo/.fleet/agents/explore.md'
};

/**
 * A manager whose children never finish, so the registry stays as dispatch left
 * it. Every test here is about the middle of a run, which is the only time the
 * question is asked.
 */
function manager(): { subagents: SubagentManager; started: TaskRun[] } {
  const started: TaskRun[] = [];
  const subagents = new SubagentManager({
    emit: () => {},
    definitions: async () => Promise.resolve([DEFINITION]),
    run: async (run) => {
      started.push(run);
      return new Promise<TaskOutcome>(() => {});
    }
  });
  return { subagents, started };
}

const dispatch = async (
  subagents: SubagentManager,
  threadId: string,
  prompt: string
): Promise<{ id: string }> =>
  subagents.dispatch({
    agent: 'explore',
    prompt,
    tools: null,
    parentModel: 'a/model',
    threadId,
    callId: 'call-1',
    cwd: '/repo'
  });

describe('SubagentManager.runningFor', () => {
  it('gives back what one conversation started, in the order it started it', async () => {
    const { subagents } = manager();
    await dispatch(subagents, 'thread-1', 'find the column width');
    await dispatch(subagents, 'thread-1', 'trace the report path');

    expect(subagents.runningFor('thread-1')).toMatchObject([
      { agent: 'explore', prompt: 'find the column width' },
      { agent: 'explore', prompt: 'trace the report path' }
    ]);
  });

  /*
   * The cap is app-wide and the registry with it, so two panes working at once
   * share one map. A parent told about the other pane's children would be told
   * about work it never asked for and cannot account for.
   */
  it('leaves out what another conversation started', async () => {
    const { subagents } = manager();
    await dispatch(subagents, 'thread-1', 'mine');
    await dispatch(subagents, 'thread-2', 'somebody else’s');

    expect(subagents.runningFor('thread-1')).toMatchObject([{ prompt: 'mine' }]);
    expect(subagents.runningFor('thread-2')).toMatchObject([{ prompt: 'somebody else’s' }]);
  });

  /*
   * A child runs under its own task id as its thread, and nothing is ever
   * dispatched with that as a parent - which is how "no nesting" holds here
   * without a second rule saying so.
   */
  it('gives a child nothing, since nothing was started in its name', async () => {
    const { subagents } = manager();
    const task = await dispatch(subagents, 'thread-1', 'find the column width');

    expect(subagents.runningFor(task.id)).toEqual([]);
  });

  it('gives back nothing for a conversation that has started none', () => {
    expect(manager().subagents.runningFor('thread-1')).toEqual([]);
  });
});
