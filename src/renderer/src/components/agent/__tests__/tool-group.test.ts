import { describe, expect, it } from 'vitest';
import type { AgentPart } from '../../../../../shared/agent-types';
import type { AgentToolCall } from '../../../../../shared/agent-tools';
import { groupParts, runLabel, runPreview, runRunning } from '../tool-group';

let next = 0;
const call = (name: string, args: string, over: Partial<AgentToolCall> = {}): AgentToolCall => ({
  id: `c${++next}`,
  name,
  args,
  result: 'ok',
  error: null,
  summary: null,
  image: null,
  todos: null,
  task: null,
  ...over
});

const tool = (name: string, args = '{}', over: Partial<AgentToolCall> = {}): AgentPart => ({
  type: 'tool',
  call: call(name, args, over)
});
const read = (path: string, over: Partial<AgentToolCall> = {}): AgentPart =>
  tool('read', JSON.stringify({ path }), over);
const text = (t = 'hello'): AgentPart => ({ type: 'text', text: t });

/** The kinds in order, as `run:read×3` / `part`, which is what most cases are about. */
const shape = (parts: AgentPart[], askCallId: string | null = null): string[] =>
  groupParts(parts, askCallId).map((item) =>
    item.kind === 'run' ? `run:${item.name}×${item.calls.length}` : 'part'
  );

describe('groupParts', () => {
  it('leaves a pair alone and folds three', () => {
    expect(shape([read('a.ts'), read('b.ts')])).toEqual(['part', 'part']);
    expect(shape([read('a.ts'), read('b.ts'), read('c.ts')])).toEqual(['run:read×3']);
  });

  it('folds each of the lookups, and nothing else', () => {
    expect(shape([tool('grep'), tool('grep'), tool('grep')])).toEqual(['run:grep×3']);
    expect(shape([tool('glob'), tool('glob'), tool('glob')])).toEqual(['run:glob×3']);
    // The row is the thing that happened, and no count stands in for it: a
    // change to a file, a command, a picture, an errand.
    for (const name of ['edit', 'write', 'bash', 'terminal', 'image', 'task', 'skill']) {
      expect(shape([tool(name), tool(name), tool(name)])).toEqual(['part', 'part', 'part']);
    }
  });

  it('does not fold two different lookups together', () => {
    // Deliberate: a model globs and then greps rather than alternating, so
    // merging them under one word for searching folds nothing extra.
    expect(shape([tool('glob'), tool('grep'), tool('glob')])).toEqual(['part', 'part', 'part']);
    expect(shape([read('a.ts'), read('b.ts'), read('c.ts'), tool('grep')])).toEqual([
      'run:read×3',
      'part'
    ]);
  });

  it('breaks a run where the model said something', () => {
    expect(shape([read('a.ts'), read('b.ts'), text(), read('c.ts'), read('d.ts')])).toEqual([
      'part',
      'part',
      'part',
      'part',
      'part'
    ]);
    expect(
      shape([read('a.ts'), read('b.ts'), read('c.ts'), text(), read('d.ts'), read('e.ts')])
    ).toEqual(['run:read×3', 'part', 'part', 'part']);
  });

  it('keeps a failed call out on its own', () => {
    // The row is the only place the reason exists. A count is where it would go
    // to be missed, so the failure both stays a row and ends the run.
    const parts = [read('a.ts'), read('b.ts'), read('c.ts', { result: null, error: 'nope' })];
    expect(shape(parts)).toEqual(['part', 'part', 'part']);
    expect(shape([...parts, read('d.ts'), read('e.ts'), read('f.ts')])).toEqual([
      'part',
      'part',
      'part',
      'run:read×3'
    ]);
  });

  it('keeps the call being asked about out on its own', () => {
    const asked = read('c.ts');
    const id = asked.type === 'tool' ? asked.call.id : '';
    expect(shape([read('a.ts'), read('b.ts'), asked], id)).toEqual(['part', 'part', 'part']);
    // And folds it back in once the question has been answered.
    expect(shape([read('a.ts'), read('b.ts'), asked], null)).toEqual(['run:read×3']);
  });

  it('runs straight through the parts that are drawn as nothing', () => {
    // A task list updated mid-sweep is bookkeeping the transcript declines to
    // show; letting it split the sweep would put a seam where a reader can see
    // no reason for one.
    expect(shape([read('a.ts'), tool('todo_update'), read('b.ts'), read('c.ts')])).toEqual([
      'run:read×3',
      'part'
    ]);
    const attachment: AgentPart = {
      type: 'attachment',
      attachment: { kind: 'mention', path: '/x.ts' }
    };
    expect(shape([read('a.ts'), attachment, read('b.ts'), read('c.ts')])).toEqual([
      'run:read×3',
      'part'
    ]);
  });

  it('gives every part back, in order, when the run was too short to fold', () => {
    const parts = [read('a.ts'), tool('todo_update'), read('b.ts')];
    expect(groupParts(parts, null).map((i) => i.key)).toEqual([0, 1, 2]);
  });

  it('keys a run on the call it started at, so a growing run stays the same run', () => {
    const opening = [text(), read('a.ts'), read('b.ts'), read('c.ts')];
    const [, run] = groupParts(opening, null);
    expect(run.key).toBe(1);
    // The next call arrives: same key, so the group is not remounted and does
    // not shut under a reader who has just opened it.
    const [, longer] = groupParts([...opening, read('d.ts')], null);
    expect(longer.key).toBe(1);
    expect(longer.kind === 'run' && longer.calls.length).toBe(4);
  });

  it('hands back the calls it folded, in order', () => {
    const [item] = groupParts([read('a.ts'), read('b.ts'), read('c.ts')], null);
    expect(item.kind === 'run' && item.calls.map((c) => c.args)).toEqual([
      '{"path":"a.ts"}',
      '{"path":"b.ts"}',
      '{"path":"c.ts"}'
    ]);
  });
});

describe('runRunning', () => {
  it('is going while its last call has not come back', () => {
    expect(runRunning([call('read', '{}'), call('read', '{}', { result: null })])).toBe(true);
    expect(runRunning([call('read', '{}', { result: null }), call('read', '{}')])).toBe(false);
    expect(runRunning([])).toBe(false);
  });
});

describe('runLabel', () => {
  it('is the verb the individual rows use, and how many there were', () => {
    expect(runLabel('read', 5, false)).toBe('Read 5 files');
    expect(runLabel('grep', 3, false)).toBe('Search 3 patterns');
    expect(runLabel('glob', 3, false)).toBe('Find 3 patterns');
  });

  it('is in the present tense while the sweep is happening', () => {
    // "Read 5 files" beside a spinner claims to have finished something it is
    // in the middle of.
    expect(runLabel('read', 4, true)).toBe('Reading 4 files');
    expect(runLabel('grep', 2, true)).toBe('Searching 2 patterns');
    expect(runLabel('glob', 2, true)).toBe('Finding 2 patterns');
  });

  it('counts one of a thing as one', () => {
    expect(runLabel('read', 1, false)).toBe('Read 1 file');
  });
});

describe('runPreview', () => {
  it('names the first two and counts the rest', () => {
    // Five filenames are how a reader checks the agent looked in the right
    // place; trading all five for the number five answers a question nobody
    // asked.
    const calls = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((p) =>
      call('read', JSON.stringify({ path: p }))
    );
    expect(runPreview('read', calls)).toBe('a.ts, b.ts +3');
    expect(runPreview('read', calls.slice(0, 2))).toBe('a.ts, b.ts');
  });

  it('drops the directory from a path, since the rows below carry the whole of it', () => {
    const calls = ['src/renderer/AgentThread.tsx', 'src/shared/tool-label.ts', 'x/y/z.ts'].map(
      (p) => call('read', JSON.stringify({ path: p }))
    );
    expect(runPreview('read', calls)).toBe('AgentThread.tsx, tool-label.ts +1');
  });

  it('leaves a pattern as it was', () => {
    const calls = [
      call('grep', '{"pattern":"useAgentStore"}'),
      call('grep', '{"pattern":"a/b"}'),
      call('grep', '{"pattern":"third"}')
    ];
    expect(runPreview('grep', calls)).toBe('useAgentStore, a/b +1');
  });

  it('names the file it is on while the sweep is still going', () => {
    // Which one of eight it is currently reading is worth more than which two
    // it started with, and is the only thing on the row still changing.
    const calls = [
      call('read', '{"path":"src/a.ts"}'),
      call('read', '{"path":"src/b.ts"}'),
      call('read', '{"path":"src/c.ts"}', { result: null })
    ];
    expect(runPreview('read', calls)).toBe('c.ts');
  });
});
