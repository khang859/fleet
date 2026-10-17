import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeService } from '../../../worktree-service';
import { NO_CREW } from '../../jobs';
import { readOnlyGit } from '../../projects/repo-reader';
import { storeFixture } from '../../__tests__/fixture';
import type { ResourceRecord } from '../../store/resource-store';
import { defaultCleaners } from '../cleaners';
import { removalVerdict } from '../worktree-safety';

/** Real git in a temp folder: what cleanup removes, and what it keeps. */

let dir: string;
let repo: string;
let fixture: ReturnType<typeof storeFixture>;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

function commit(cwd: string, name: string): void {
  writeFileSync(join(cwd, name), name);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', name);
}

const BRANCH = 'admiral/1/builder-1-1';

/** A worktree on its own branch from main, the way crew get one. */
function crewWorktree(): ResourceRecord {
  const path = join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', path, '-b', BRANCH);
  return {
    id: 1,
    jobId: 1,
    kind: 'member_worktree',
    member: 'app',
    path,
    branch: BRANCH,
    label: 'builder-1 worktree',
    status: 'live',
    detail: '',
    attempts: 0
  };
}

const clean = async (
  r: ResourceRecord
): ReturnType<ReturnType<typeof defaultCleaners>['member_worktree']> =>
  defaultCleaners({
    store: fixture.store,
    crew: NO_CREW,
    git: readOnlyGit,
    worktrees: new WorktreeService()
  }).member_worktree(r);

const branches = (): string[] => git(repo, 'branch', '--format=%(refname:short)').split('\n');

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-cleanup-')));
  repo = join(dir, 'app');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV });
  commit(repo, 'base.txt');
  fixture = storeFixture();
});

afterEach(() => {
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('removalVerdict', () => {
  it('removes only a worktree with nothing to lose', () => {
    expect(removalVerdict({ dirty: 0, untracked: 0, unmerged: 0 })).toEqual({ remove: true });
    expect(removalVerdict({ dirty: 1, untracked: 12, unmerged: 2 })).toEqual({
      remove: false,
      reason: '1 uncommitted change, 12 untracked files, 2 commits on no other branch or remote'
    });
    expect(removalVerdict({ dirty: 0, untracked: 0, unmerged: null })).toEqual({
      remove: false,
      reason: 'git could not tell if its commits are safe'
    });
  });
});

describe('worktree cleaner', () => {
  it('removes a worktree whose branch is pushed, and its local branch', async () => {
    const remote = join(dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote], { env: ENV });
    git(repo, 'remote', 'add', 'origin', remote);
    const wt = crewWorktree();
    commit(wt.path!, 'feature.txt');
    git(wt.path!, 'push', '-q', 'origin', BRANCH);

    expect(await clean(wt)).toEqual({ status: 'cleaned' });

    expect(existsSync(wt.path!)).toBe(false);
    expect(branches()).toEqual(['main']);
    expect(git(repo, 'ls-remote', '--heads', 'origin')).toContain(BRANCH);
  });

  it('removes a worktree whose work is merged into main', async () => {
    const wt = crewWorktree();
    commit(wt.path!, 'feature.txt');
    git(repo, 'merge', '-q', '--ff-only', BRANCH);

    expect(await clean(wt)).toEqual({ status: 'cleaned' });
    expect(branches()).toEqual(['main']);
  });

  it.each<[string, (path: string) => void, string]>([
    ['untracked files', (p) => writeFileSync(join(p, 'design.png'), 'x'), '1 untracked file'],
    ['uncommitted changes', (p) => writeFileSync(join(p, 'base.txt'), 'x'), '1 uncommitted change'],
    [
      'commits only it has',
      (p) => commit(p, 'feature.txt'),
      '1 commit on no other branch or remote'
    ]
  ])('keeps a worktree with %s, and its branch', async (_, change, reason) => {
    const wt = crewWorktree();
    change(wt.path!);

    expect(await clean(wt)).toEqual({ status: 'kept', reason });

    expect(existsSync(wt.path!)).toBe(true);
    expect(branches()).toContain(BRANCH);
  });

  it('counts a worktree that was never made as cleaned', async () => {
    const never = { ...crewWorktree(), path: join(dir, 'never-made') };
    expect(await clean(never)).toEqual({ status: 'cleaned' });
  });
});
