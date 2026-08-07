import { describe, expect, it } from 'vitest';
import type {
  AgentMessage,
  AgentPart,
  AgentPermissionAsk
} from '../../../../../shared/agent-types';
import { pendingTaskAsks } from '../task-permissions';

const taskPart = (taskId: string, agent: string): AgentPart => ({
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
    task: { id: taskId, agent, prompt: 'look at the diff', status: 'running', summary: null }
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

describe('pendingTaskAsks', () => {
  it('names each question after the subagent that asked it', () => {
    const messages = [message([taskPart('task-1', 'review'), taskPart('task-2', 'explore')])];

    expect(pendingTaskAsks(messages, { 'task-2': ask('rg -n useAgent src') })).toEqual([
      { taskId: 'task-2', agent: 'explore', ask: ask('rg -n useAgent src') }
    ]);
  });

  it('keeps every question, so several at once are all answerable', () => {
    const messages = [message([taskPart('task-1', 'review'), taskPart('task-2', 'explore')])];

    const pending = pendingTaskAsks(messages, {
      'task-1': ask('git log'),
      'task-2': ask('git diff')
    });

    expect(pending.map((p) => p.agent)).toEqual(['review', 'explore']);
  });

  // Being unable to name it is not a reason to hide it: the subagent is stopped
  // until this is answered, and the strip is the only thing offering to.
  it('still lists a question whose card is not in the transcript', () => {
    expect(pendingTaskAsks([], { 'task-9': ask('git log') })).toEqual([
      { taskId: 'task-9', agent: 'subagent', ask: ask('git log') }
    ]);
  });

  it('has nothing to show when nothing is waiting', () => {
    expect(pendingTaskAsks([message([taskPart('task-1', 'review')])], {})).toEqual([]);
  });
});
