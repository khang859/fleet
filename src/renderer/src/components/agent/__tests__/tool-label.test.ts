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

  it('names the file a change is about', () => {
    expect(toolLabel(call('edit', '{"path":"src/a.ts"}'))).toEqual({
      verb: 'Edit',
      target: 'src/a.ts'
    });
    expect(toolLabel(call('write', '{"path":"src/a.ts"}'))).toEqual({
      verb: 'Write',
      target: 'src/a.ts'
    });
  });

  it('shows a command as the command it is', () => {
    expect(toolLabel(call('bash', '{"command":"npm test"}'))).toEqual({
      verb: 'Run',
      target: 'npm test'
    });
  });

  // The row is one line, so a command written across several becomes one.
  it('flattens a multi-line command onto the row', () => {
    expect(toolLabel(call('bash', '{"command":"npm run build \\\\\\n  --silent"}')).target).toBe(
      'npm run build \\ --silent'
    );
  });

  it('falls back to the tool name for anything it does not know', () => {
    expect(toolLabel(call('wobble', '{"path":"a.ts"}'))).toEqual({ verb: 'wobble', target: '' });
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

describe('image', () => {
  const image = (args: object): AgentToolCall => call('image', JSON.stringify(args));

  it('shows the prompt, because the picture does not exist yet', () => {
    expect(toolLabel(image({ prompt: 'a teal officer cap' }))).toEqual({
      verb: 'Generate',
      target: 'a teal officer cap'
    });
  });

  it('says it is editing when the call names references', () => {
    expect(
      toolLabel(image({ prompt: 'the same cap in navy', references: ['assets/cap.png'] }))
    ).toEqual({ verb: 'Edit image', target: 'the same cap in navy' });
  });

  // A prompt is prose and often several lines; the row is one line.
  it('flattens a prompt written over several lines', () => {
    expect(toolLabel(image({ prompt: 'a cap,\n  seen from above' })).target).toBe(
      'a cap, seen from above'
    );
  });
});
