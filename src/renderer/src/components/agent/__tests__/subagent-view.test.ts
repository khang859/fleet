import { describe, expect, it } from 'vitest';
import type {
  AgentMessage,
  AgentPart,
  AgentPermissionAsk
} from '../../../../../shared/agent-types';
import type { AgentTaskStatus } from '../../../../../shared/agent-tools';
import { runningSubagents, showSubagentPanel, type RunningSubagent } from '../subagent-view';
import { SIDE_COLUMN_KEEP_PX, SIDE_COLUMN_MIN_PANE_PX } from '../side-column';

const taskPart = (
  taskId: string,
  agent: string,
  prompt = 'look at the diff',
  status: AgentTaskStatus = 'running'
): AgentPart => ({
  type: 'tool',
  call: {
    id: `call-${taskId}`,
    name: 'task',
    args: '{}',
    result: null,
    error: null,
    summary: null,
    image: null,
    todos: null,
    task: { id: taskId, agent, prompt, status, summary: null }
  }
});

const message = (parts: AgentPart[]): AgentMessage => ({
  id: 'm1',
  role: 'assistant',
  parts,
  reasoning: '',
  reasoningMs: null
});

const ask = (command: string): AgentPermissionAsk => ({
  streamId: 's1',
  requestId: 'r1',
  callId: 'c1',
  command,
  reason: null,
  rule: command,
  mcp: null
});

const one = (running: RunningSubagent[], taskId: string): RunningSubagent => {
  const found = running.find((subagent) => subagent.taskId === taskId);
  if (found === undefined) throw new Error(`no ${taskId} in the list`);
  return found;
};

describe('runningSubagents', () => {
  const transcript = [
    message([taskPart('task-1', 'review', 'check the gate'), taskPart('task-2', 'explore')])
  ];

  it('lists what each running subagent is and what it is doing', () => {
    const running = runningSubagents(transcript, { 'task-1': 'reading gate.ts' }, {});

    expect(running).toEqual([
      {
        taskId: 'task-1',
        agent: 'review',
        prompt: 'check the gate',
        activity: 'reading gate.ts',
        asking: false
      }
    ]);
  });

  it('says a child that has not called anything yet is doing nothing yet', () => {
    expect(one(runningSubagents(transcript, { 'task-1': null }, {}), 'task-1').activity).toBeNull();
  });

  /*
   * The live registry rather than the statuses in the transcript: a subagent the
   * app was quit on is left saying `running` on its card until the reconcile
   * marks it interrupted, and a list built from that would offer to stop a
   * process that no longer exists.
   */
  it('lists only the children the pane has running, not every one it dispatched', () => {
    const running = runningSubagents(transcript, { 'task-2': null }, {});

    expect(running.map((subagent) => subagent.taskId)).toEqual(['task-2']);
  });

  it('marks the one stopped on a command, since it is waiting rather than working', () => {
    const running = runningSubagents(
      transcript,
      { 'task-1': 'running git log', 'task-2': null },
      { 'task-1': ask('git log') }
    );

    expect(running.map((subagent) => subagent.asking)).toEqual([true, false]);
  });

  /*
   * The activity map is rebuilt on every tool event a child sends, so its own
   * order is whatever five children reporting progress happen to produce. The
   * transcript's is the order they were sent out in, which is the one the reader
   * has already seen.
   */
  it('keeps them in the order they were dispatched', () => {
    const running = runningSubagents(transcript, { 'task-2': null, 'task-1': null }, {});

    expect(running.map((subagent) => subagent.taskId)).toEqual(['task-1', 'task-2']);
  });

  // The pane was given another session while this one was still going. Hiding it
  // would leave a subagent running with nothing on screen offering to stop it.
  it('still lists a child whose call is not in the transcript', () => {
    expect(runningSubagents([], { 'task-9': 'reading a file' }, {})).toEqual([
      { taskId: 'task-9', agent: 'subagent', prompt: '', activity: 'reading a file', asking: false }
    ]);
  });

  it('has nothing to show when nothing is running', () => {
    expect(runningSubagents(transcript, {}, {})).toEqual([]);
  });
});

describe('showSubagentPanel', () => {
  const running = runningSubagents(
    [message([taskPart('task-1', 'review')])],
    { 'task-1': null },
    {}
  );

  it('takes a column only when the pane has the room', () => {
    expect(showSubagentPanel(running, { shown: false, width: SIDE_COLUMN_MIN_PANE_PX })).toBe(true);
    expect(showSubagentPanel(running, { shown: false, width: SIDE_COLUMN_MIN_PANE_PX - 1 })).toBe(
      false
    );
  });

  it('holds a column it already has down to a lower width', () => {
    const width = SIDE_COLUMN_MIN_PANE_PX - 10;

    expect(showSubagentPanel(running, { width, shown: true })).toBe(true);
    expect(showSubagentPanel(running, { width, shown: false })).toBe(false);
    expect(showSubagentPanel(running, { width: SIDE_COLUMN_KEEP_PX - 1, shown: true })).toBe(false);
  });

  it('waits for a measurement rather than guessing', () => {
    expect(showSubagentPanel(running, { width: null, shown: false })).toBe(false);
  });

  /*
   * A subagent outlives the turn that dispatched it, so an idle composer over a
   * working child is the ordinary case rather than a stale one - and the case
   * the card is most worth having in.
   */
  it('stays up between turns, unlike the task list', () => {
    expect(showSubagentPanel(running, { width: 2000, shown: true })).toBe(true);
  });

  it('goes the moment the last one reports', () => {
    expect(showSubagentPanel([], { width: 2000, shown: true })).toBe(false);
  });
});
