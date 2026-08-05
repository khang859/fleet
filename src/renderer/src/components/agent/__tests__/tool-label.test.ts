import { describe, expect, it } from 'vitest';
import type { AgentToolCall } from '../../../../../shared/agent-tools';
import { toolLabel, toolStatus } from '../tool-label';

const call = (name: string, args: string, over: Partial<AgentToolCall> = {}): AgentToolCall => ({
  id: 'c1',
  name,
  args,
  result: null,
  error: null,
  summary: null,
  ...over
});

describe('toolLabel', () => {
  it('names what happened rather than which tool did it', () => {
    expect(toolLabel(call('read', '{"path":"src/a.ts"}'))).toEqual({
      verb: 'Read',
      target: 'src/a.ts'
    });
    expect(toolLabel(call('glob', '{"pattern":"**/*.ts"}'))).toEqual({
      verb: 'Find',
      target: '**/*.ts'
    });
    expect(toolLabel(call('grep', '{"pattern":"useAgentStore"}'))).toEqual({
      verb: 'Search',
      target: 'useAgentStore'
    });
  });

  it('says where the search was narrowed to', () => {
    expect(toolLabel(call('glob', '{"pattern":"*.ts","path":"src/main"}')).target).toBe(
      '*.ts in src/main'
    );
    expect(toolLabel(call('grep', '{"pattern":"x","glob":"*.tsx"}')).target).toBe('x in *.tsx');
  });

  // A row exists from the moment the call starts, which is before the model
  // has finished streaming the arguments into it.
  it('renders a call whose arguments have not finished arriving', () => {
    expect(toolLabel(call('read', '{"path":'))).toEqual({ verb: 'Read', target: '' });
    expect(toolLabel(call('read', ''))).toEqual({ verb: 'Read', target: '' });
  });

  it('falls back to the tool name for anything it does not know', () => {
    expect(toolLabel(call('write', '{"path":"a.ts"}'))).toEqual({ verb: 'write', target: '' });
  });
});

describe('toolStatus', () => {
  it('is running until something comes back', () => {
    expect(toolStatus(call('read', '{}'))).toBe('running');
    expect(toolStatus(call('read', '{}', { result: 'a.ts lines 1-1' }))).toBe('done');
    expect(toolStatus(call('read', '{}', { error: 'no such file' }))).toBe('failed');
  });

  // An empty result is still a result: "no files matched" is an answer.
  it('counts an empty result as finished', () => {
    expect(toolStatus(call('glob', '{}', { result: '' }))).toBe('done');
  });
});
