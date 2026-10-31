import { describe, expect, it } from 'vitest';
import {
  MAX_PARALLEL_TASKS,
  MAX_TASKS_PER_THREAD,
  type SubagentDefinition
} from '../../../../shared/agent-subagents';
import { SubagentCapReached, SubagentManager, type TaskOutcome, type TaskRun } from '../manager';

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

/*
 * The cap, and the one thing about it that is not like the other refusal here.
 * "There is no subagent called X" will still be true next round; this stops
 * being true the moment a child reports, and the model is expected to try
 * again. `runTask` spends that difference on how the row is drawn.
 */
describe('SubagentManager.dispatch, at the parallel cap', () => {
  it('turns the next one away with a type of its own', async () => {
    const { subagents } = manager();
    for (let i = 0; i < MAX_PARALLEL_TASKS; i++) {
      await dispatch(subagents, `thread-${i}`, `job ${i}`);
    }

    await expect(dispatch(subagents, 'thread-fresh', 'one too many')).rejects.toBeInstanceOf(
      SubagentCapReached
    );
  });

  /* Counted across the app rather than per conversation - it is about the rate
   * limit and the bill, and neither of those is per pane. */
  it('counts the children of every conversation towards it', async () => {
    const { subagents } = manager();
    await dispatch(subagents, 'thread-1', 'mine');
    await dispatch(subagents, 'thread-1', 'mine too');
    for (let i = 0; i < MAX_PARALLEL_TASKS - 2; i++) {
      await dispatch(subagents, `thread-other-${i}`, `job ${i}`);
    }

    // Under its own limit of three, and refused anyway: the slots are gone.
    await expect(dispatch(subagents, 'thread-1', 'a third')).rejects.toBeInstanceOf(
      SubagentCapReached
    );
  });

  /*
   * And no conversation may take every slot. Without this, a model that fans
   * out four children in one round refuses every other pane in the app for as
   * long as they run - work in one pane stopping work in another, which is the
   * thing this whole area is meant not to do.
   */
  it('stops one conversation holding every slot', async () => {
    const { subagents } = manager();
    for (let i = 0; i < MAX_TASKS_PER_THREAD; i++) {
      await dispatch(subagents, 'greedy', `job ${i}`);
    }

    await expect(dispatch(subagents, 'greedy', 'one more')).rejects.toBeInstanceOf(
      SubagentCapReached
    );
  });

  it('leaves the slots it did not take for somebody else', async () => {
    const { subagents } = manager();
    for (let i = 0; i < MAX_TASKS_PER_THREAD; i++) {
      await dispatch(subagents, 'greedy', `job ${i}`);
    }

    await expect(dispatch(subagents, 'patient', 'mine')).resolves.toMatchObject({
      status: 'running'
    });
  });

  /* A name that is not a subagent is a mistake, not a queue, and still reads as
   * one - which is the whole reason the cap needed its own type. */
  it('leaves a bad name as an ordinary failure', async () => {
    const { subagents } = manager();

    await expect(
      subagents.dispatch({
        agent: 'nonesuch',
        prompt: 'go',
        tools: null,
        parentModel: 'a/model',
        threadId: 'thread-1',
        callId: 'call-1',
        cwd: '/repo'
      })
    ).rejects.not.toBeInstanceOf(SubagentCapReached);
  });
});
