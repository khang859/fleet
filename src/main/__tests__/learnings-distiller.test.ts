import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseDraft, serializeTranscript, distillLearning } from '../learnings/distiller';
import type { SessionTranscript } from '../../shared/sessions';

describe('parseDraft', () => {
  it('treats the sentinel as nothing-to-record', () => {
    expect(parseDraft('NO_LEARNING')).toEqual({ status: 'nothing' });
    expect(parseDraft('  NO_LEARNING\n')).toEqual({ status: 'nothing' });
    expect(parseDraft('NO_LEARNING — routine refactor')).toEqual({ status: 'nothing' });
    expect(parseDraft('')).toEqual({ status: 'nothing' });
  });

  it('matches sentinel variants with trailing punctuation but not lookalikes', () => {
    expect(parseDraft('NO_LEARNING.')).toEqual({ status: 'nothing' });
    expect(parseDraft('NO_LEARNING:')).toEqual({ status: 'nothing' });
    expect(parseDraft('NO_LEARNING—nothing here')).toEqual({ status: 'nothing' });
    // A real word that merely starts with the sentinel is still a draft.
    expect(parseDraft('# NO_LEARNINGS were drawn\nbody').status).toBe('ok');
  });

  it('uses the LAST Tags: line, leaving an inline body mention intact', () => {
    const raw = [
      '# A lesson',
      '',
      'We added Tags: to the output format earlier in this note.',
      'Tags: real, footer'
    ].join('\n');
    const r = parseDraft(raw);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.draft.tags).toEqual(['real', 'footer']);
    // The inline mention stays in the body; only the footer line is consumed.
    expect(r.draft.body).toContain('We added Tags: to the output');
    expect(r.draft.body).not.toContain('real, footer');
  });

  it('extracts title, body, and tags from a well-formed draft', () => {
    const raw = [
      '# better-sqlite3 ABI mismatch in tests',
      '',
      '## Problem',
      'Tests failed against the Electron ABI.',
      '## Fix',
      'Rebuild for node before vitest.',
      'Tags: sqlite, testing, abi'
    ].join('\n');
    const r = parseDraft(raw);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.draft.title).toBe('better-sqlite3 ABI mismatch in tests');
    expect(r.draft.tags).toEqual(['sqlite', 'testing', 'abi']);
    expect(r.draft.body).toContain('## Problem');
    expect(r.draft.body).not.toContain('# better-sqlite3'); // H1 hoisted into title
    expect(r.draft.body).not.toContain('Tags:'); // tags line removed from body
  });

  it('strips wrapping code fences the agent may add', () => {
    const r = parseDraft('```markdown\n# Title here\nbody line\n```');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.draft.title).toBe('Title here');
    expect(r.draft.body).toBe('body line');
  });

  it('falls back to first non-empty line when no H1 is present', () => {
    const r = parseDraft('A plain insight without a heading.\nmore detail');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.draft.title).toBe('A plain insight without a heading.');
    expect(r.draft.body).toBe('more detail');
    expect(r.draft.tags).toEqual([]);
  });
});

describe('distillLearning', () => {
  it('reports a clear error when the session cwd no longer exists', async () => {
    const gone = join(tmpdir(), 'fleet-nonexistent-cwd-xyz-123');
    const t: SessionTranscript = {
      summary: {
        agent: 'rune',
        id: 's1',
        title: 't',
        project: 'p',
        cwd: gone,
        updatedAt: 0,
        messageCount: 1,
        preview: ''
      },
      messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
    };
    const res = await distillLearning(t);
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.message).toContain('no longer exists');
    expect(res.message).not.toContain('not installed');
  });
});

describe('serializeTranscript', () => {
  const t: SessionTranscript = {
    summary: {
      agent: 'claude',
      id: 's1',
      title: 't',
      project: 'p',
      cwd: '/x',
      updatedAt: 0,
      messageCount: 2,
      preview: ''
    },
    messages: [
      { role: 'user', blocks: [{ type: 'text', text: 'fix the bug' }] },
      {
        role: 'assistant',
        blocks: [
          { type: 'tool_use', name: 'Edit', argsPreview: 'a.ts' },
          { type: 'tool_result', output: 'ok', isError: false },
          { type: 'text', text: 'done' }
        ]
      }
    ]
  };

  it('flattens roles and blocks to text', () => {
    const out = serializeTranscript(t);
    expect(out).toContain('## user');
    expect(out).toContain('fix the bug');
    expect(out).toContain('[tool: Edit a.ts]');
    expect(out).toContain('[result: ok]');
    expect(out).toContain('done');
  });

  it('truncates very long transcripts', () => {
    const big: SessionTranscript = {
      ...t,
      messages: [{ role: 'user', blocks: [{ type: 'text', text: 'x'.repeat(100_000) }] }]
    };
    const out = serializeTranscript(big);
    expect(out.length).toBeLessThan(60_000);
    expect(out).toContain('[transcript truncated]');
  });
});
