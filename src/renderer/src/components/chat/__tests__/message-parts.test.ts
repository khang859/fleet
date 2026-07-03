import { describe, it, expect } from 'vitest';
import { resolveRenderParts } from '../message-parts';
import type { ChatMessage, ChatToolCall } from '../../../../../shared/chat-types';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: '',
    parentId: null,
    createdAt: 0,
    ...overrides
  };
}

const bash: ChatToolCall = { id: 't1', name: 'bash', title: 'ls', status: 'done' };
const web: ChatToolCall = { id: 't2', name: 'web_fetch', title: 'example.com', status: 'done' };

describe('resolveRenderParts', () => {
  it('returns the recorded ordered parts verbatim when present', () => {
    const parts = [
      { type: 'text' as const, text: 'first' },
      { type: 'tool' as const, call: bash },
      { type: 'text' as const, text: 'second' }
    ];
    expect(resolveRenderParts(msg({ parts, content: 'firstsecond', toolCalls: [bash] }))).toBe(
      parts
    );
  });

  it('falls back to legacy grouped order (tools then text) for turns without parts', () => {
    const result = resolveRenderParts(msg({ content: 'the answer', toolCalls: [bash, web] }));
    expect(result).toEqual([
      { type: 'tool', call: bash },
      { type: 'tool', call: web },
      { type: 'text', text: 'the answer' }
    ]);
  });

  it('legacy text-only turn yields a single text block', () => {
    expect(resolveRenderParts(msg({ content: 'hello' }))).toEqual([
      { type: 'text', text: 'hello' }
    ]);
  });

  it('legacy turn with no content and no tools yields no blocks', () => {
    expect(resolveRenderParts(msg({ content: '' }))).toEqual([]);
  });
});
