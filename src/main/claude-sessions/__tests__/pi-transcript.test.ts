import { describe, expect, it } from 'vitest';
import { normalizePiLine, parsePiLine, PiUsage } from '../pi-transcript';

function entry(id: string, parentId: string | null, message: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-10-31T01:00:00.000Z',
    message
  });
}

const assistant = (
  usage: Record<string, unknown>,
  model = 'gpt-test'
): Record<string, unknown> => ({
  role: 'assistant',
  model,
  content: [{ type: 'text', text: 'ok' }],
  usage
});

describe('normalizePiLine', () => {
  it('reads a user prompt', () => {
    const [event] = normalizePiLine(
      entry('a', null, { role: 'user', content: [{ type: 'text', text: 'hello' }] })
    );
    expect(event).toMatchObject({
      uuid: 'a',
      parentUuid: null,
      role: 'user',
      kind: 'user_prompt',
      text: 'hello'
    });
  });

  it('reads the text, thinking and tool blocks of an assistant message', () => {
    const events = normalizePiLine(
      entry('b', 'a', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hm' },
          { type: 'text', text: 'done' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }
        ]
      })
    );
    expect(events.map((e) => e.kind)).toEqual(['thinking', 'assistant_text', 'tool_use']);
    expect(events[2]).toMatchObject({ id: 't1', name: 'Bash', input: { command: 'ls' } });
  });

  it('reads a tool result, with its error flag', () => {
    const [event] = normalizePiLine(
      entry('c', 'b', {
        role: 'toolResult',
        toolCallId: 't1',
        isError: true,
        content: [{ type: 'text', text: 'no such file' }]
      })
    );
    expect(event).toMatchObject({
      kind: 'tool_result',
      toolUseId: 't1',
      isError: true,
      text: 'no such file'
    });
  });

  it('keeps an entry with no message in the parent chain', () => {
    const line = JSON.stringify({ type: 'model_change', id: 'd', parentId: 'c' });
    expect(normalizePiLine(line)).toEqual([
      expect.objectContaining({ uuid: 'd', parentUuid: 'c', kind: 'meta', subtype: 'model_change' })
    ]);
  });

  it('gives nothing for the header, a blank line or a torn line', () => {
    expect(normalizePiLine(JSON.stringify({ type: 'session', id: 's', cwd: '/x' }))).toEqual([]);
    expect(normalizePiLine('  ')).toEqual([]);
    expect(normalizePiLine('{"type":"mess')).toEqual([]);
  });
});

describe('PiUsage', () => {
  it('adds up spend, and keeps the context of the latest message', () => {
    const usage = new PiUsage();
    usage.add(
      parsePiLine(entry('a', null, assistant({ totalTokens: 100, cost: { total: 0.25 } })))
    );
    usage.add(
      parsePiLine(entry('b', 'a', assistant({ totalTokens: 300, cost: { total: 0.5 } }, 'other')))
    );
    expect(usage.costUsd).toBe(0.75);
    expect(usage.contextTokens).toBe(300);
    expect([...usage.models]).toEqual(['gpt-test', 'other']);
  });

  it('keeps the last context through a failed request, which reports no tokens', () => {
    const usage = new PiUsage();
    usage.add(parsePiLine(entry('a', null, assistant({ totalTokens: 100 }))));
    usage.add(parsePiLine(entry('b', 'a', assistant({ totalTokens: 0 }))));
    expect(usage.contextTokens).toBe(100);
  });

  it('counts only assistant messages', () => {
    const usage = new PiUsage();
    usage.add(
      parsePiLine(entry('a', null, { role: 'user', content: 'hi', usage: { totalTokens: 9 } }))
    );
    usage.add(null);
    expect(usage.contextTokens).toBeNull();
    expect(usage.costUsd).toBe(0);
  });
});
