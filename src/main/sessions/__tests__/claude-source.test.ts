import { describe, it, expect } from 'vitest';
import { claudeMessagesToTranscriptMessages, claudePreview } from '../claude-source';
import type { CopilotChatMessage } from '../../../shared/types';

const MESSAGES: CopilotChatMessage[] = [
  { id: 'm1', role: 'user', timestamp: '2026-05-01T10:00:00Z', blocks: [{ type: 'text', text: 'refactor the api' }] },
  {
    id: 'm2',
    role: 'assistant',
    timestamp: '2026-05-01T10:00:05Z',
    blocks: [
      { type: 'thinking', text: 'considering...' },
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 't1', name: 'Edit', inputPreview: 'api.ts', input: { path: 'api.ts' } }
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
