import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { NO_PLAN_CHECKS } from '../../../../shared/agency-jobs';
import { PlanSchema } from '../../../../shared/agency-plan';
import { openJob, REPO, storeFixture } from '../../__tests__/fixture';
import { fakeGh, git, initRepo, tempDir, writeFiles } from '../../projects/__tests__/git-fixture';
import { readOnlyGit } from '../../projects/repo-reader';
import type { AgencyStore } from '../../store/agency-store';
import {
  READ_CAPS,
  readCommits,
  readInstructions,
  readPastJobs,
  readPrs,
  readReviews
} from '../collect';

let dir: string;
let cleanupDir: () => void;

beforeEach(() => {
  ({ dir, cleanup: cleanupDir } = tempDir('fleet-read-'));
});
afterEach(() => cleanupDir());

describe('readInstructions', () => {
  it('reads the project files at the default branch tip and only ~/.claude/CLAUDE.md at home', async () => {
    const root = initRepo(join(dir, 'repo'), {
      'CLAUDE.md': '- Use pnpm, never npm.\n',
      'AGENTS.md': '- Keep PRs small.\n'
    });
    writeFiles(root, { 'CLAUDE.md': '- Not committed yet.\n' });
    const home = join(dir, 'home');
    writeFiles(home, {
      '.claude/CLAUDE.md': '- Reproduce a bug before fixing it.\n',
      '.claude.json': '{"oauthAccount":"secret"}',
      '.claude/settings.json': '{"env":{"KEY":"secret"}}'
    });
    const out = await readInstructions(root, { git: readOnlyGit, userHome: home });
    expect(out).toEqual([
      { tag: 'CLAUDE.md', items: ['- Use pnpm, never npm.'] },
      { tag: 'AGENTS.md', items: ['- Keep PRs small.'] },
      { tag: 'your CLAUDE.md', items: ['- Reproduce a bug before fixing it.'] }
    ]);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('cuts a long file', async () => {
    const root = initRepo(join(dir, 'repo'), { 'CLAUDE.md': 'x'.repeat(9_000) });
    const [file] = await readInstructions(root, { git: readOnlyGit, userHome: join(dir, 'none') });
    expect(file.items[0]).toHaveLength(READ_CAPS.instructionChars + 1);
  });
});

describe('readCommits', () => {
  it('reads the messages of the client’s own commits only', async () => {
    const root = initRepo(join(dir, 'repo'), { 'a.txt': 'a' });
    git(root, 'config', 'user.email', 'test@example.com');
    writeFiles(root, { 'b.txt': 'b' });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'feat(cli): add --json', '-m', 'Tests in __tests__.');
    writeFiles(root, { 'c.txt': 'c' });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '--author', 'Other <other@example.com>', '-m', 'chore: theirs');
    const out = await readCommits(root, readOnlyGit);
    expect(out).toEqual({
      tag: 'your commits',
      items: ['feat(cli): add --json\nTests in __tests__.', 'init']
    });
  });

  it('reads nothing when git has no email for the client', async () => {
    const empty = async (args: string[]): Promise<string | null> =>
      Promise.resolve(args[0] === 'config' ? null : 'should not be read');
    expect(await readCommits(dir, empty)).toBeNull();
  });
});

const REVIEWS = {
  data: {
    search: {
      nodes: [
        {
          reviews: {
            nodes: [
              {
                body: 'Where is the test for this?',
                comments: { nodes: [{ body: 'Name this for what it does.' }, { body: ' ' }] }
              }
            ]
          }
        },
        {}
      ]
    }
  }
};

describe('readReviews', () => {
  it('reads the signed-in user’s review summaries and comments', async () => {
    const calls: string[][] = [];
    const gh = fakeGh((args) => {
      calls.push(args);
      if (args[1] === 'user') return { code: 0, stdout: 'octo-cat\n' };
      return { code: 0, stdout: JSON.stringify(REVIEWS) };
    });
    expect(await readReviews('acme/fleet', { gh, cwd: dir })).toEqual({
      tag: 'your review comments',
      items: ['Where is the test for this?', 'Name this for what it does.']
    });
    expect(calls[1]).toContain('q=repo:acme/fleet is:pr reviewed-by:octo-cat sort:updated-desc');
  });

  it('reads nothing when the GitHub CLI is not signed in', async () => {
    const gh = fakeGh(() => ({ code: 1, stdout: '' }));
    expect(await readReviews('acme/fleet', { gh, cwd: dir })).toBeNull();
  });
});

describe('readPrs', () => {
  it('reads titles and descriptions, each cut to size', async () => {
    const gh = fakeGh(() => ({
      code: 0,
      stdout: JSON.stringify([
        { title: 'Add dark mode', body: 'Why: users asked.' },
        { title: 'Long', body: 'y'.repeat(2_000) }
      ])
    }));
    const out = await readPrs('acme/fleet', { gh, cwd: dir });
    expect(out?.items[0]).toBe('Add dark mode\n\nWhy: users asked.');
    expect(out?.items[1]).toHaveLength(READ_CAPS.prChars + 1);
  });
});

describe('readPastJobs', () => {
  let store: AgencyStore;
  let cleanup: () => void;
  beforeEach(() => {
    ({ store, cleanup } = storeFixture());
  });
  afterEach(() => cleanup());

  const plan = (titles: string[]) =>
    PlanSchema.parse({
      playbook: 'feature',
      summary: 'Add a flag.',
      steps: titles.map((title, i) => ({ id: `s${i}`, role: 'builder', title })),
      budget: { usd: 5 }
    });

  it('reads plan edits as before and after, turn-down notes and answers, newest job first', () => {
    const first = openJob(store);
    const v1 = store.plans.insertVersion({
      jobId: first.id,
      kind: 'initial',
      author: 'admiral',
      parentVersion: null,
      plan: plan(['Build it', 'End-to-end tests']),
      checks: NO_PLAN_CHECKS
    });
    store.plans.insertVersion({
      jobId: first.id,
      kind: 'initial',
      author: 'client',
      parentVersion: v1.version,
      plan: plan(['Build it']),
      checks: NO_PLAN_CHECKS
    });
    const second = openJob(store, REPO.repoId, 'Add docs');
    const turned = store.plans.insertVersion({
      jobId: second.id,
      kind: 'initial',
      author: 'admiral',
      parentVersion: null,
      plan: plan(['Write docs']),
      checks: NO_PLAN_CHECKS
    });
    store.plans.decide(turned.id, 'rejected', 'Skip docs unless I ask.');
    const q = store.askQuestion({
      repoId: REPO.repoId,
      jobId: second.id,
      question: 'Which reviewer?',
      options: [{ label: 'Opus' }, { label: 'Sonnet' }]
    });
    store.answerQuestion({ id: q.id, option: 1, text: 'cheaper' });
    expect(readPastJobs(store, REPO.repoId)?.items).toEqual([
      `j${second.id}: you turned down plan v1: Skip docs unless I ask.`,
      `j${second.id}: asked "Which reviewer?", you answered "Sonnet: cheaper"`,
      `j${first.id}: you changed plan v1.\nBefore: builder: Build it; builder: End-to-end tests\nAfter: builder: Build it`
    ]);
  });

  it('reads nothing from jobs the client never changed or answered', () => {
    openJob(store);
    expect(readPastJobs(store, REPO.repoId)).toBeNull();
  });
});
