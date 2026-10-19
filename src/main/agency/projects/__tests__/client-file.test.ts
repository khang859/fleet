import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mergeClientFile,
  numberedText,
  STARTER_SOURCE,
  YOU_LAYER
} from '../../../../shared/agency-client-file';
import type { ClientLineInput } from '../../../../shared/agency-projects';
import { ClientFiles, extractRules, ruleCandidates } from '../client-file';
import { clientFilePath } from '../paths';
import { initRepo, tempDir, writeFiles } from './git-fixture';

/** The client file: sourced lines, no duplicates, and rules picked out of CLAUDE.md. */

const REPO_ID = '0123456789abcdef';
const OCT_17 = new Date(2026, 9, 17, 12);
const OCT_20 = new Date(2026, 9, 20, 12);

let tmp: { dir: string; cleanup: () => void };
let home: string;
let marks: Map<string, string>;
let clock: Date;
let files: ClientFiles;

beforeEach(() => {
  tmp = tempDir('fleet-client-file-');
  home = join(tmp.dir, 'agency-home');
  marks = new Map();
  clock = OCT_17;
  files = new ClientFiles({
    store: {
      clientFileMark: (repoId) => marks.get(repoId) ?? null,
      markClientFile: (repoId, text) => void marks.set(repoId, text),
      preferences: { conflicts: () => [] }
    },
    home: () => home,
    now: () => clock
  });
});
afterEach(() => tmp.cleanup());

const write = (lines: ClientLineInput[], now: Date, replaceSource?: string): string => {
  clock = now;
  return files.merge(REPO_ID, { name: 'shop', replaceSource, lines });
};

describe('ClientFiles.merge', () => {
  it('writes each line with where it came from and when', () => {
    const text = write(
      [
        'Open PRs as drafts.',
        'Show me a job only after checks, review and QA pass.',
        'Default job budget: $10 and 10% of my weekly Claude limit.',
        'Notify me for questions and results only.'
      ].map((t) => ({ text: t, source: STARTER_SOURCE })),
      OCT_17
    );
    expect(text).toBe(
      [
        '# shop',
        '- Open PRs as drafts. (from starter questions, 2026-10-17)',
        '- Show me a job only after checks, review and QA pass. (from starter questions, 2026-10-17)',
        '- Default job budget: $10 and 10% of my weekly Claude limit. (from starter questions, 2026-10-17)',
        '- Notify me for questions and results only. (from starter questions, 2026-10-17)',
        ''
      ].join('\n')
    );
    expect(readFileSync(clientFilePath(REPO_ID, home), 'utf8')).toBe(text);
  });

  it('skips a line the file already says, whoever said it first', () => {
    write([{ text: 'Use pnpm, never npm.', source: 'CLAUDE.md' }], OCT_17);
    const text = write(
      [
        { text: 'use pnpm,  never npm', source: 'AGENTS.md' },
        { text: 'Run the API tests before a PR.', source: 'CLAUDE.md' }
      ],
      OCT_20
    );
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      '- Use pnpm, never npm. (from CLAUDE.md, 2026-10-17)',
      '- Run the API tests before a PR. (from CLAUDE.md, 2026-10-20)'
    ]);
  });

  it('replaces the last starter answers, and keeps lines the client typed', () => {
    write([{ text: 'Open PRs as drafts.', source: STARTER_SOURCE }], OCT_17);
    const typed = `${readFileSync(clientFilePath(REPO_ID, home), 'utf8')}- Never touch the billing code.\n`;
    writeFiles(home, { [`clients/${REPO_ID}.md`]: typed });

    const text = write(
      [{ text: 'Open PRs ready for review.', source: STARTER_SOURCE }],
      OCT_20,
      STARTER_SOURCE
    );
    expect(text).toBe(
      [
        '# shop',
        '- Never touch the billing code.',
        '- Open PRs ready for review. (from starter questions, 2026-10-20)',
        ''
      ].join('\n')
    );
  });

  it('is what the Admiral reads at the start of a round, cut short past its limit', () => {
    expect(files.forNote(REPO_ID)).toBeNull();
    write([{ text: 'Open PRs as drafts.', source: STARTER_SOURCE }], OCT_17);
    expect(files.forNote(REPO_ID)).toEqual({
      text: 'P1. Open PRs as drafts. (from starter questions, 2026-10-17)',
      changedOutside: false,
      oversize: false
    });
    files.write(REPO_ID, 'x'.repeat(9_000));
    expect(files.forNote(REPO_ID)).toMatchObject({ changedOutside: false, oversize: true });
    expect(files.forNote(REPO_ID)?.text.endsWith('[cut off]')).toBe(true);
  });

  it('keeps a merged line to one line', () => {
    const text = mergeClientFile(
      null,
      { name: 'shop', add: [{ text: 'a\nb   c', source: 's' }] },
      '2026-10-17'
    );
    expect(text).toBe('# shop\n- a b c (from s, 2026-10-17)\n');
  });
});

describe('ClientFiles proposals and outside changes', () => {
  const START = [
    { text: 'Open PRs ready for review.', source: STARTER_SOURCE },
    { text: 'Use npm.', source: 'CLAUDE.md' },
    { text: 'Notify me for everything.', source: STARTER_SOURCE }
  ];

  it('swaps a contradicted line in place, removes and adds, each tagged with its job', () => {
    write(START, OCT_17);
    clock = OCT_20;
    const text = files.apply(REPO_ID, {
      name: 'shop',
      source: 'job j3',
      proposal: {
        add: [
          { text: 'Open PRs as drafts.', replaces: 'open prs ready for review' },
          { text: 'Use pnpm, never npm.', replaces: null }
        ],
        remove: ['Notify me for everything.']
      }
    });
    expect(text).toBe(
      [
        '# shop',
        '- Open PRs as drafts. (from job j3, 2026-10-20)',
        '- Use npm. (from CLAUDE.md, 2026-10-17)',
        '- Use pnpm, never npm. (from job j3, 2026-10-20)',
        ''
      ].join('\n')
    );
    expect(files.changedOutside(REPO_ID)).toBe(false);
  });

  it('adds a line whose old line the client already edited away', () => {
    write(START.slice(0, 1), OCT_17);
    const text = files.apply(REPO_ID, {
      name: 'shop',
      source: 'the lobby',
      proposal: { add: [{ text: 'Open PRs as drafts.', replaces: 'Gone line.' }], remove: [] }
    });
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
  });

  it("shows a change made outside Fleet, and keeps Fleet's version in the note until kept", () => {
    write(START.slice(0, 1), OCT_17);
    const fleets = files.read(REPO_ID).trim();
    writeFiles(home, { [`clients/${REPO_ID}.md`]: `${fleets}\n- Spend whatever you like.\n` });

    expect(files.changedOutside(REPO_ID)).toBe(true);
    expect(files.forNote(REPO_ID)).toEqual({
      text: numberedText(fleets, 'P'),
      changedOutside: true,
      oversize: false
    });

    files.keep(REPO_ID);
    expect(files.changedOutside(REPO_ID)).toBe(false);
    expect(files.forNote(REPO_ID)?.text).toContain('Spend whatever you like.');
  });

  it('counts a file Fleet never wrote, or one deleted, as changed outside', () => {
    writeFiles(home, { [`clients/${REPO_ID}.md`]: '# shop\n- Typed in vim.\n' });
    expect(files.forNote(REPO_ID)).toEqual({ text: '', changedOutside: true, oversize: false });
    files.keep(REPO_ID);
    rmSync(files.path(REPO_ID));
    expect(files.changedOutside(REPO_ID)).toBe(true);
  });

  it("undoes a change made outside Fleet back to Fleet's version, a deleted file too", () => {
    write(START.slice(0, 1), OCT_17);
    const fleets = files.read(REPO_ID);
    writeFiles(home, { [`clients/${REPO_ID}.md`]: '# shop\n- Spend whatever you like.\n' });
    files.undo(REPO_ID);
    expect(files.read(REPO_ID)).toBe(fleets);
    expect(files.changedOutside(REPO_ID)).toBe(false);

    rmSync(files.path(REPO_ID));
    files.undo(REPO_ID);
    expect(files.read(REPO_ID)).toBe(fleets);
  });

  it('takes a hand edit saved in Settings as it is', () => {
    write(START, OCT_17);
    files.write(REPO_ID, '# shop\n- Only my own words.\n');
    expect(files.changedOutside(REPO_ID)).toBe(false);
    expect(files.forNote(REPO_ID)?.text).toBe('P1. Only my own words.');
  });
});

const CLAUDE_MD = `# Shop

Some prose about the project that is not a rule.

## Rules

- Use pnpm. The component library uses npm.
- Run the API tests before a PR.
* Never commit to main directly.
- ok
  - A nested detail that belongs to the line above it.

\`\`\`bash
- pnpm test  # inside a code block, not a rule
\`\`\`

- Use pnpm. The component library uses npm.
`;

describe('the You layer', () => {
  it('lives in its own file beside the project files, with its own outside-change mark', () => {
    files.merge(YOU_LAYER, {
      name: 'You',
      lines: [{ text: 'Never push to main.', source: 'you' }]
    });
    files.merge(REPO_ID, { name: 'shop', lines: [{ text: 'Use pnpm.', source: 'you' }] });

    expect(clientFilePath(YOU_LAYER, home)).toBe(join(home, 'you.md'));
    expect(files.read(YOU_LAYER)).toBe('# You\n- Never push to main. (from you, 2026-10-17)\n');
    expect(files.read(REPO_ID)).toContain('Use pnpm.');
    writeFileSync(files.path(YOU_LAYER), '# You\n- Edited in an editor.\n');
    expect(files.changedOutside(YOU_LAYER)).toBe(true);
    expect(files.changedOutside(REPO_ID)).toBe(false);
  });
});

describe('ClientFiles.changeLine', () => {
  it('adds a line as told by the client, then edits and removes it', () => {
    expect(files.changeLine(REPO_ID, { kind: 'add', name: 'shop', text: 'Use pnpm' })).toEqual({
      ok: true
    });
    clock = OCT_20;
    files.changeLine(REPO_ID, { kind: 'edit', index: 0, was: 'Use pnpm', text: 'Use pnpm 9' });
    expect(files.read(REPO_ID)).toBe('# shop\n- Use pnpm 9 (from you, 2026-10-20)\n');
    files.changeLine(REPO_ID, { kind: 'remove', index: 0, was: 'Use pnpm 9' });
    expect(files.read(REPO_ID)).toBe('# shop\n');
  });

  it('refuses while the file has an outside change, and for a line that moved', () => {
    files.changeLine(REPO_ID, { kind: 'add', name: 'shop', text: 'Use pnpm' });
    expect(files.changeLine(REPO_ID, { kind: 'remove', index: 0, was: 'Use yarn' })).toMatchObject({
      ok: false,
      reason: 'That line changed since you opened it.'
    });
    writeFileSync(files.path(REPO_ID), '# shop\n- Hand edit.\n');
    expect(
      files.changeLine(REPO_ID, { kind: 'remove', index: 0, was: 'Hand edit.' })
    ).toMatchObject({
      ok: false
    });
    expect(files.read(REPO_ID)).toBe('# shop\n- Hand edit.\n');
  });
});

describe('rules from CLAUDE.md', () => {
  it('takes the top-level list items outside code, once each, and not the tiny ones', () => {
    expect(extractRules(CLAUDE_MD)).toEqual([
      'Use pnpm. The component library uses npm.',
      'Run the API tests before a PR.',
      'Never commit to main directly.'
    ]);
  });

  it('reads CLAUDE.md and AGENTS.md at the default branch', async () => {
    const root = initRepo(join(tmp.dir, 'shop'), {
      'CLAUDE.md': CLAUDE_MD,
      'AGENTS.md': '- Keep the README up to date.\n'
    });
    // An edit not yet committed is not what the team agreed on.
    writeFiles(root, { 'AGENTS.md': '- Something uncommitted and unreviewed.\n' });
    expect(await ruleCandidates(root)).toEqual([
      { source: 'CLAUDE.md', rules: extractRules(CLAUDE_MD) },
      { source: 'AGENTS.md', rules: ['Keep the README up to date.'] }
    ]);
  });
});
