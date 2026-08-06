import { describe, expect, it } from 'vitest';
import type { AgentToolCall } from '../../../../../shared/agent-tools';
import { diffBody } from '../diff-body';

const call = (over: Partial<AgentToolCall>): AgentToolCall => ({
  id: 'c1',
  name: 'edit',
  args: '{}',
  result: null,
  error: null,
  summary: null,
  image: null,
  todos: null,
  ...over
});

const EDIT_RESULT = [
  'Edited a.ts (+1 -1)',
  'The user is shown this change as a diff, so do not repeat the new code in your reply.',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO'
].join('\n');

describe('diffBody', () => {
  it('shows the diff and nothing that was addressed to the model', () => {
    expect(diffBody(call({ result: EDIT_RESULT, summary: '+1 -1' }))).toEqual([
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO'
    ]);
  });

  it('is nothing for a call that did not change a file', () => {
    expect(
      diffBody(call({ name: 'read', result: 'a.ts lines 1-3', summary: '3 lines' }))
    ).toBeNull();
    expect(diffBody(call({ name: 'grep', result: 'a.ts:1: one', summary: '1 match' }))).toBeNull();
  });

  it('shows a created file as added lines, taken from what was written', () => {
    const created = call({
      name: 'write',
      args: JSON.stringify({ path: 'b.ts', content: 'export const a = 1;\nexport const b = 2;\n' }),
      result: 'Created b.ts (2 lines). The user is shown the file you wrote…',
      summary: '2 lines'
    });

    expect(diffBody(created)).toEqual(['+export const a = 1;', '+export const b = 2;']);
  });

  it('shows nothing for a write that changed nothing', () => {
    const same = call({
      name: 'write',
      args: JSON.stringify({ path: 'b.ts', content: 'unchanged\n' }),
      result: 'b.ts already contains exactly that',
      summary: 'no change'
    });

    expect(diffBody(same)).toBeNull();
  });

  it('survives arguments that never finished arriving', () => {
    expect(
      diffBody(call({ name: 'write', args: '{"path":"b.ts","cont', summary: '2 lines' }))
    ).toBeNull();
  });
});
