import { describe, expect, it } from 'vitest';
import type { GhRun } from '../../projects/gh';
import type { GitWrite } from '../job-workspace';
import { pushAndOpenPr, type OpenPrInput } from '../open-pr';

const INPUT: OpenPrInput = {
  root: '/repo',
  branch: 'admiral/j2/build-1',
  base: 'main',
  title: 'Add multiply',
  body: 'Adds multiply(a, b).',
  draft: true
};

const URL = 'https://github.com/acme/app/pull/7';

/** git and gh as the test sets them, with every call they got. */
function fakes(opts: { push?: boolean; open?: string | null; create?: boolean } = {}): {
  git: GitWrite;
  gh: GhRun;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitWrite = async (args) => {
    calls.push(['git', ...args]);
    return Promise.resolve(opts.push === false ? null : '');
  };
  const gh: GhRun = async (args) => {
    calls.push(['gh', ...args]);
    if (args[1] === 'view') {
      const open = opts.open ?? null;
      const view = open === null ? null : { url: open, state: 'OPEN' };
      return Promise.resolve(view === null ? { code: 1, stdout: '' } : json(view));
    }
    return Promise.resolve(opts.create === false ? { code: 1, stdout: '' } : text(URL));
  };
  return { git, gh, calls };
}

const json = (value: unknown): { code: number; stdout: string } => text(JSON.stringify(value));
const text = (stdout: string): { code: number; stdout: string } => ({ code: 0, stdout });

describe('pushAndOpenPr', () => {
  it('pushes the branch and opens a draft PR against the default branch', async () => {
    const { git, gh, calls } = fakes();

    expect(await pushAndOpenPr(INPUT, { git, gh })).toEqual({ ok: true, url: URL });
    expect(calls).toEqual([
      ['git', 'push', '--quiet', '-u', 'origin', 'admiral/j2/build-1:admiral/j2/build-1'],
      ['gh', 'pr', 'view', 'admiral/j2/build-1', '--json', 'url,state'],
      [
        'gh',
        'pr',
        'create',
        '--head',
        'admiral/j2/build-1',
        '--base',
        'main',
        '--title',
        'Add multiply',
        '--body',
        'Adds multiply(a, b).',
        '--draft'
      ]
    ]);
  });

  it('opens a PR ready for review when draft is off', async () => {
    const { git, gh, calls } = fakes();

    await pushAndOpenPr({ ...INPUT, draft: false }, { git, gh });

    expect(calls.at(-1)).not.toContain('--draft');
  });

  it('pushes a fix to the open PR the branch already has, and opens no other', async () => {
    const { git, gh, calls } = fakes({ open: URL });

    expect(await pushAndOpenPr(INPUT, { git, gh })).toEqual({ ok: true, url: URL });
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ['git', 'push', '--quiet'],
      ['gh', 'pr', 'view']
    ]);
  });

  it('never pushes the default branch', async () => {
    const { git, gh, calls } = fakes();

    const out = await pushAndOpenPr({ ...INPUT, branch: 'main' }, { git, gh });

    expect(out).toEqual({ ok: false, reason: 'main is the default branch' });
    expect(calls).toEqual([]);
  });

  it('says why when the push or the PR fails', async () => {
    const push = fakes({ push: false });
    expect(await pushAndOpenPr(INPUT, push)).toEqual({
      ok: false,
      reason: 'git could not push admiral/j2/build-1 to origin'
    });
    expect(push.calls).toHaveLength(1);

    const create = fakes({ create: false });
    expect(await pushAndOpenPr(INPUT, create)).toEqual({
      ok: false,
      reason: 'gh could not open a PR for admiral/j2/build-1'
    });
  });
});
