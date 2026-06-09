import { describe, it, expect } from 'vitest';
import { summarizeRune, readRuneTranscript } from '../rune-source';

const RAW = {
  id: 'a1b2c3d4e5f6g7h8',
  name: 'Fix auth bug',
  created: '2026-04-30T09:08:07Z',
  provider: 'groq',
  model: 'mixtral-8x7b-32768',
  cwd: '/Users/khang/projects/myapp',
  root_id: 'root',
  active_id: 'n2',
  nodes: [
    { id: 'root', parent_id: '', children: ['n1'], has_message: false, created: '2026-04-30T09:08:07Z' },
    {
      id: 'n1',
      parent_id: 'root',
      children: ['n2'],
      has_message: true,
      message: { role: 'user', content: [{ type: 'text', text: 'fix the login issue in auth.go' }] },
      created: '2026-04-30T09:08:08Z'
    },
    {
      id: 'n2',
      parent_id: 'n1',
      children: [],
      has_message: true,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I found it in auth.go' },
          { type: 'tool_use', id: 't1', name: 'read', args: '{"path":"auth.go"}' }
        ]
      },
      created: '2026-04-30T09:08:12Z'
    }
  ],
  subagents: [],
  files_read: ['/Users/khang/projects/myapp/auth.go']
};

describe('summarizeRune', () => {
  it('builds a summary from the active path', () => {
    const s = summarizeRune(RAW, 1700000000000);
    expect(s).not.toBeNull();
    expect(s!.agent).toBe('rune');
    expect(s!.id).toBe('a1b2c3d4e5f6g7h8');
    expect(s!.title).toBe('Fix auth bug');
    expect(s!.model).toBe('mixtral-8x7b-32768');
    expect(s!.provider).toBe('groq');
    expect(s!.cwd).toBe('/Users/khang/projects/myapp');
    expect(s!.project).toBe('myapp');
    expect(s!.messageCount).toBe(2);
    expect(s!.preview).toBe('fix the login issue in auth.go');
    expect(s!.updatedAt).toBe(1700000000000);
  });

  it('falls back to preview when name is missing', () => {
    const s = summarizeRune({ ...RAW, name: undefined }, 1);
    expect(s!.title).toBe('fix the login issue in auth.go');
  });

  it('returns null for malformed input', () => {
    expect(summarizeRune({ nope: true }, 1)).toBeNull();
  });
});

describe('readRuneTranscript', () => {
  it('flattens the root->active path into messages', () => {
    const t = readRuneTranscript(RAW, 1)!;
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(t.messages[0].blocks).toEqual([{ type: 'text', text: 'fix the login issue in auth.go' }]);
    expect(t.messages[1].blocks).toEqual([
      { type: 'text', text: 'I found it in auth.go' },
      { type: 'tool_use', id: 't1', name: 'read', argsPreview: '{"path":"auth.go"}' }
    ]);
  });
});
