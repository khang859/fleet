import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeClientFile, STARTER_SOURCE } from '../../../../shared/agency-client-file';
import type { ClientLineInput } from '../../../../shared/agency-projects';
import { RECOMMENDED_STARTER, starterLines } from '../../../../shared/agency-starter';
import { clientFileForNote, extractRules, ruleCandidates, writeClientLines } from '../client-file';
import { clientFilePath } from '../paths';
import { initRepo, tempDir, writeFiles } from './git-fixture';

/** The client file: sourced lines, no duplicates, and rules picked out of CLAUDE.md. */

const REPO_ID = '0123456789abcdef';
const OCT_17 = new Date(2026, 9, 17, 12);
const OCT_20 = new Date(2026, 9, 20, 12);

let tmp: { dir: string; cleanup: () => void };
let home: string;

beforeEach(() => {
  tmp = tempDir('fleet-client-file-');
  home = join(tmp.dir, 'agency-home');
});
afterEach(() => tmp.cleanup());

const write = async (
  lines: ClientLineInput[],
  now: Date,
  replaceSource?: string
): Promise<string> =>
  writeClientLines({ repoId: REPO_ID, name: 'shop', replaceSource, lines }, { home, now });

describe('writeClientLines', () => {
  it('writes each line with where it came from and when', async () => {
    const text = await write(
      starterLines(RECOMMENDED_STARTER).map((t) => ({ text: t, source: STARTER_SOURCE })),
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

  it('skips a line the file already says, whoever said it first', async () => {
    await write([{ text: 'Use pnpm, never npm.', source: 'CLAUDE.md' }], OCT_17);
    const text = await write(
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

  it('replaces the last starter answers, and keeps lines the client typed', async () => {
    await write([{ text: 'Open PRs as drafts.', source: STARTER_SOURCE }], OCT_17);
    const typed = `${readFileSync(clientFilePath(REPO_ID, home), 'utf8')}- Never touch the billing code.\n`;
    writeFiles(home, { [`clients/${REPO_ID}.md`]: typed });

    const text = await write(
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

  it('is what the Admiral reads at the start of a round, cut short past its limit', async () => {
    expect(clientFileForNote(REPO_ID, home)).toBeNull();
    await write([{ text: 'Open PRs as drafts.', source: STARTER_SOURCE }], OCT_17);
    expect(clientFileForNote(REPO_ID, home)).toBe(
      '# shop\n- Open PRs as drafts. (from starter questions, 2026-10-17)'
    );
    writeFiles(home, { [`clients/${REPO_ID}.md`]: 'x'.repeat(9_000) });
    expect(clientFileForNote(REPO_ID, home)?.endsWith('[cut off]')).toBe(true);
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
