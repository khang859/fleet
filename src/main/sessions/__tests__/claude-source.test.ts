import { describe, it, expect } from 'vitest';
import { claudeMessagesToTranscriptMessages, claudePreview } from '../claude-source';
import { parseClaudeTranscript } from '../../copilot/conversation-reader';
import type { CopilotChatMessage } from '../../../shared/types';

const MESSAGES: CopilotChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    timestamp: '2026-05-01T10:00:00Z',
    blocks: [{ type: 'text', text: 'refactor the api' }]
  },
  {
    id: 'm2',
    role: 'assistant',
    timestamp: '2026-05-01T10:00:05Z',
    blocks: [
      { type: 'thinking', text: 'considering...' },
      { type: 'text', text: 'done' },
      {
        type: 'tool_use',
        id: 't1',
        name: 'Edit',
        inputPreview: 'api.ts',
        input: { path: 'api.ts' }
      }
    ]
  }
];

describe('claudeMessagesToTranscriptMessages', () => {
  it('maps copilot blocks into normalized blocks', () => {
    const msgs = claudeMessagesToTranscriptMessages(MESSAGES);
    expect(msgs[0]).toEqual({ role: 'user', blocks: [{ type: 'text', text: 'refactor the api' }] });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].blocks).toEqual([
      { type: 'text', text: 'considering...' },
      { type: 'text', text: 'done' },
      { type: 'tool_use', name: 'Edit', argsPreview: 'api.ts', id: 't1' }
    ]);
  });
});

describe('claudePreview', () => {
  it('returns the first user text', () => {
    expect(claudePreview(MESSAGES)).toBe('refactor the api');
  });
});

describe('parseClaudeTranscript', () => {
  it('counts user/assistant message lines and skips meta/non-message lines', () => {
    const jsonl = [
      JSON.stringify({ type: 'summary', summary: 'meta — not a message' }),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        cwd: '/p',
        message: { role: 'user', content: 'hello' }
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/a/b.ts' } }
          ]
        }
      }),
      // duplicate tool id in a later line must not double-count or duplicate the block
      JSON.stringify({
        type: 'assistant',
        uuid: 'a2',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/a/b.ts' } }]
        }
      }),
      '' // trailing blank line
    ].join('\n');

    const messages = parseClaudeTranscript(jsonl);
    // summary line skipped; u1 + a1 kept; a2's only block is a duplicate tool id -> dropped
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(messages[0].blocks).toEqual([{ type: 'text', text: 'hello' }]);
    expect(messages[1].blocks[0]).toEqual({ type: 'text', text: 'hi' });
  });

  it('resets on a /clear command line', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }),
      '{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}',
      JSON.stringify({
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: 'after clear' }
      })
    ].join('\n');
    const messages = parseClaudeTranscript(jsonl);
    expect(messages.map((m) => m.id)).toEqual(['u2']);
  });
});
