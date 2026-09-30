import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { BriefBuilder, renderBrief, type BriefStatus } from '../brief';
import { normalizeLine, TranscriptTail, type TranscriptEvent } from '../transcript';

const FIXTURES = join(__dirname, 'fixtures');
const turns = readFileSync(join(FIXTURES, 'turns.jsonl'));
const tasks = readFileSync(join(FIXTURES, 'tasks.jsonl'));

const STATUS: BriefStatus = {
  phase: 'waiting for a prompt for 3m',
  usage: { costUsd: 1.234, contextTokens: 50_000, contextLimit: 200_000 },
  git: { branch: 'main', dirtyFiles: 2, insertions: 10, deletions: 3, truncated: false }
};

/** Build a brief from the whole file at once. */
function onePass(bytes: Buffer): BriefBuilder {
  const builder = new BriefBuilder();
  for (const line of bytes.toString('utf8').split('\n')) {
    for (const event of normalizeLine(line)) builder.apply(event);
  }
  return builder;
}

/** Build a brief as a tail would, from the file arriving `size` bytes at a time. */
function incremental(bytes: Buffer, size: number): BriefBuilder {
  const builder = new BriefBuilder();
  const tail = new TranscriptTail({
    onLine: (line) => line.events.forEach((e) => builder.apply(e))
  });
  for (let i = 0; i < bytes.length; i += size) tail.feed(bytes.subarray(i, i + size));
  return builder;
}

function event(e: Partial<TranscriptEvent> & Pick<TranscriptEvent, 'kind'>): TranscriptEvent {
  return { uuid: 'x', timestamp: null, role: 'assistant', ...e } as TranscriptEvent;
}

describe('BriefBuilder', () => {
  it('renders the golden brief for each fixture', async () => {
    await expect(`${renderBrief(onePass(turns).state, STATUS)}\n`).toMatchFileSnapshot(
      './fixtures/turns.brief.txt'
    );
    await expect(`${renderBrief(onePass(tasks).state, STATUS)}\n`).toMatchFileSnapshot(
      './fixtures/tasks.brief.txt'
    );
  });

  it('renders the same brief built incrementally and in one pass', () => {
    for (const bytes of [turns, tasks]) {
      const whole = renderBrief(onePass(bytes).state, STATUS);
      for (const size of [1, 7, 64, 1000]) {
        expect(renderBrief(incremental(bytes, size).state, STATUS)).toBe(whole);
      }
      // The same holds for every delta.
      const rev = onePass(bytes).state.rev;
      for (const since of [1, Math.floor(rev / 2), rev - 1]) {
        expect(renderBrief(incremental(bytes, 13).state, STATUS, { since })).toBe(
          renderBrief(onePass(bytes).state, STATUS, { since })
        );
      }
    }
  });

  it('folds TaskCreate and TaskUpdate as Claude Code 2.1.285 writes them', () => {
    const { todos } = onePass(tasks).state;
    // alpha was completed and beta deleted.
    expect(todos?.value).toEqual([{ id: '1', subject: 'alpha', status: 'completed' }]);
  });

  it('folds TodoWrite', () => {
    const b = new BriefBuilder();
    b.apply(
      event({
        kind: 'tool_use',
        id: 't',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'one', status: 'completed', activeForm: 'Doing one' },
            { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
            { content: 'three', status: 'bogus' }
          ]
        }
      })
    );
    expect(b.state.todos).toBeNull();
    b.apply(
      event({ kind: 'tool_result', toolUseId: 't', isError: false, rejected: false, text: 'ok' })
    );
    expect(b.state.todos?.value.map((t) => `${t.subject}:${t.status}`)).toEqual([
      'one:completed',
      'two:in_progress',
      'three:pending'
    ]);
  });

  it('collects what the fixture session did', () => {
    const s = onePass(turns).state;
    expect(s.goal?.value).toBe('Add a retry to fetchUser — and keep the tests green');
    expect(s.prompt?.value).toBe('look at this screenshot');
    expect(s.turns).toBe(5);
    expect([...s.files.keys()]).toEqual(['/work/app/src/client.ts']);
    expect(s.commands.map((c) => [c.command.split('\n')[0], c.ok])).toEqual([
      ['npm test -- client', false],
      ['rm -rf .cache', false]
    ]);
    expect(s.failures.map((f) => [f.tool, f.error.split('\n')[0]])).toEqual([
      ['Bash', 'FAIL src/client.test.ts'],
      ['Bash', 'rejected by the user']
    ]);
    // The question was cancelled by the interrupt and then superseded.
    expect(s.question).toBeNull();
    // The last turn was interrupted before Claude said anything.
    expect(s.reply?.value).toEqual({ text: 'The background build finished.', turn: 2 });
  });

  it('shows prompts as the user typed them and paths relative to the session folder', () => {
    const b = new BriefBuilder();
    b.apply(
      event({
        kind: 'user_prompt',
        role: 'user',
        source: 'human',
        text: '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the auth PR</command-args>'
      })
    );
    b.apply(
      event({
        kind: 'user_prompt',
        role: 'user',
        source: 'task',
        text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Build finished</summary>\n</task-notification>'
      })
    );
    b.apply(
      event({
        kind: 'tool_use',
        id: 'w',
        name: 'Write',
        input: { file_path: '/work/app/src/a.ts' }
      })
    );
    b.apply(
      event({ kind: 'tool_result', toolUseId: 'w', isError: false, rejected: false, text: '' })
    );
    b.apply(event({ kind: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } }));
    b.apply(
      event({
        kind: 'tool_result',
        toolUseId: 'b',
        isError: true,
        rejected: false,
        text: '\u001b[31mFAIL\u001b[39m a.test.ts'
      })
    );
    const out = renderBrief(b.state, { ...STATUS, cwd: '/work/app' });
    expect(out).toContain('Goal:\n  /review the auth PR');
    expect(out).toContain('Latest prompt (turn 2):\n  [background task] Build finished');
    expect(out).toContain('Files changed:\n  src/a.ts');
    expect(out).toContain('Bash npm test: FAIL a.test.ts');
  });

  it('keeps a question open until it is answered', () => {
    const b = new BriefBuilder();
    b.apply(
      event({
        kind: 'tool_use',
        id: 'q',
        name: 'AskUserQuestion',
        input: {
          questions: [{ question: 'Which DB?', options: [{ label: 'pg' }, { label: 'sqlite' }] }]
        }
      })
    );
    expect(renderBrief(b.state, STATUS)).toContain('Which DB? (options: pg | sqlite)');
    b.apply(
      event({ kind: 'tool_result', toolUseId: 'q', isError: false, rejected: false, text: 'pg' })
    );
    expect(b.state.question).toBeNull();
  });

  it('shows only what changed since a revision', () => {
    const b = onePass(turns);
    const rev = b.state.rev;
    expect(renderBrief(b.state, STATUS, { since: rev })).toContain(
      'Nothing changed since the last read.'
    );
    b.apply(event({ kind: 'assistant_text', text: 'Now looking at the screenshot.' }));
    const delta = renderBrief(b.state, STATUS, { since: rev });
    expect(delta).toContain('Last reply:\n  Now looking at the screenshot.');
    expect(delta).not.toContain('Goal:');
    expect(delta).not.toContain('Files changed:');
    // The status line is always there.
    expect(delta.split('\n')[0]).toBe(
      'waiting for a prompt for 3m · ~$1.23 · context 25% · git main, 2 changed (+10 -3)'
    );
  });

  it('starts over on /clear without reusing revisions', () => {
    const b = onePass(turns);
    const rev = b.state.rev;
    b.apply(event({ kind: 'clear', role: 'user' }));
    expect(b.state.goal).toBeNull();
    expect(b.state.files.size).toBe(0);
    expect(b.state.rev).toBeGreaterThan(rev);
  });

  it('cuts whole lines to fit the cap and says what it cut', () => {
    const b = new BriefBuilder();
    for (let i = 0; i < 30; i++) {
      b.apply(
        event({
          kind: 'tool_use',
          id: `e${i}`,
          name: 'Write',
          input: { file_path: `/work/app/src/some/long/folder/name/file-${i}.ts` }
        })
      );
      b.apply(
        event({
          kind: 'tool_result',
          toolUseId: `e${i}`,
          isError: false,
          rejected: false,
          text: 'ok'
        })
      );
    }
    const out = renderBrief(b.state, STATUS, { cap: 600 });
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toMatch(
      /\[cut to fit: Files changed \(\d+ lines\); fleet_read with since "start" shows more\]$/
    );
    expect(renderBrief(b.state, STATUS).length).toBeLessThanOrEqual(3_500);
  });

  it('keeps no more than the recent files, commands and failures', () => {
    const b = new BriefBuilder();
    for (let i = 0; i < 50; i++) {
      b.apply(
        event({ kind: 'tool_use', id: `c${i}`, name: 'Bash', input: { command: `cmd ${i}` } })
      );
      b.apply(
        event({
          kind: 'tool_result',
          toolUseId: `c${i}`,
          isError: true,
          rejected: false,
          text: 'x'
        })
      );
    }
    expect(b.state.commands.map((c) => c.command)).toEqual(
      Array.from({ length: 8 }, (_, i) => `cmd ${42 + i}`)
    );
    expect(b.state.failures).toHaveLength(5);
  });
});
