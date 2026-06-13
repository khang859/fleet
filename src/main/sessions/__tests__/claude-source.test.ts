import { describe, it, expect } from 'vitest';
import {
  claudeMessagesToTranscriptMessages,
  claudePreview,
  cwdFromTranscript
} from '../claude-source';
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

describe('cwdFromTranscript', () => {
  // Recent Claude Code versions prepend metadata lines that carry no cwd.
  it('finds cwd past leading metadata lines (last-prompt/mode/file-history-snapshot)', () => {
    const jsonl = [
      JSON.stringify({ type: 'last-prompt', leafUuid: 'x', sessionId: 's' }),
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        cwd: '/Users/me/proj',
        message: { role: 'user', content: 'hi' }
      })
    ].join('\n');
    expect(cwdFromTranscript(jsonl)).toBe('/Users/me/proj');
  });

  it('returns empty string when no line carries a cwd', () => {
    expect(cwdFromTranscript('{"type":"last-prompt"}\n{"type":"mode"}')).toBe('');
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

import { aggregateClaudeUsage } from '../claude-source';

function assistantLine(opts: {
  id: string;
  model: string;
  ts?: string;
  branch?: string;
  sidechain?: boolean;
  usage: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${opts.id}-${Math.random()}`,
    timestamp: opts.ts,
    gitBranch: opts.branch,
    isSidechain: opts.sidechain ?? false,
    message: { id: opts.id, model: opts.model, role: 'assistant', usage: opts.usage }
  });
}

describe('aggregateClaudeUsage', () => {
  it('aggregates tokens, dedups by message.id, splits cache writes', () => {
    const jsonl = [
      assistantLine({
        id: 'msg_1',
        model: 'claude-opus-4-8',
        ts: '2026-05-01T10:00:00Z',
        branch: 'feature/x',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 5 }
        }
      }),
      // duplicate message.id (second content-block line) must NOT double-count
      assistantLine({
        id: 'msg_1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 5 }
        }
      }),
      assistantLine({
        id: 'msg_2',
        model: 'claude-opus-4-8',
        ts: '2026-05-01T10:05:00Z',
        // no cache_creation object -> cache_creation_input_tokens counts as 5m
        usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 8 }
      })
    ].join('\n');

    const agg = aggregateClaudeUsage(jsonl);
    expect(agg.total).toEqual({
      input: 300,
      output: 30,
      cacheRead: 50,
      cacheWrite5m: 28, // 20 + 8
      cacheWrite1h: 5
    });
    expect(agg.models).toEqual(['claude-opus-4-8']);
    expect(agg.gitBranch).toBe('feature/x');
    expect(agg.startedAt).toBe(Date.parse('2026-05-01T10:00:00Z'));
    expect(agg.endedAt).toBe(Date.parse('2026-05-01T10:05:00Z'));
    expect(agg.hasUsage).toBe(true);
    expect(agg.perModel.get('claude-opus-4-8')?.input).toBe(300);
  });

  it('tracks multiple models in first-appearance order and includes sidechains', () => {
    const jsonl = [
      assistantLine({ id: 'a', model: 'claude-opus-4-8', usage: { output_tokens: 10 } }),
      assistantLine({
        id: 'b',
        model: 'claude-haiku-4-5',
        sidechain: true,
        usage: { output_tokens: 4 }
      })
    ].join('\n');
    const agg = aggregateClaudeUsage(jsonl);
    expect(agg.models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
    expect(agg.total.output).toBe(14); // sidechain counted
    expect(agg.perModel.get('claude-haiku-4-5')?.output).toBe(4);
    expect(agg.perModel.get('claude-opus-4-8')?.output).toBe(10);
  });

  it('reports hasUsage=false when no assistant usage exists', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    const agg = aggregateClaudeUsage(jsonl);
    expect(agg.hasUsage).toBe(false);
    expect(agg.models).toEqual([]);
  });
});
