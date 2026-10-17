import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOnlyGit } from '../../projects/repo-reader';
import { memberFacts } from '../plan-facts';

/** Real git in a temp folder: what the plan check reads off a member checkout. */

let dir: string;
let repo: string;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
};

const APP = (): { name: string; path: string; root: string } => ({
  name: 'app',
  path: '.',
  root: repo
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

function commit(name: string): string {
  writeFileSync(join(repo, name), name);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', name);
  return git(repo, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-plan-facts-')));
  repo = join(dir, 'app');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('memberFacts', () => {
  it('reads a clean checkout with no remote', async () => {
    const tip = commit('a.txt');

    expect(await memberFacts(APP(), readOnlyGit)).toEqual({
      name: 'app',
      atRoot: true,
      githubSlug: null,
      dirty: 0,
      hasAdmiralBranch: false,
      defaultBranch: 'main',
      defaultSha: tip,
      headBranch: 'main',
      headSha: tip
    });
  });

  it('counts uncommitted and untracked changes, and sees a branch named admiral', async () => {
    commit('a.txt');
    writeFileSync(join(repo, 'a.txt'), 'changed');
    writeFileSync(join(repo, 'new.txt'), 'new');
    git(repo, 'branch', 'admiral');

    const facts = await memberFacts(APP(), readOnlyGit);

    expect(facts.dirty).toBe(2);
    expect(facts.hasAdmiralBranch).toBe(true);
  });

  it('takes the default tip from the remote view, and HEAD from where the client is', async () => {
    const tip = commit('a.txt');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    git(repo, 'update-ref', 'refs/remotes/origin/main', tip);
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    // Unpushed work on main and a feature branch checked out: neither is the default tip.
    commit('b.txt');
    git(repo, 'checkout', '-q', '-b', 'feat/x');
    const head = commit('c.txt');

    const facts = await memberFacts(APP(), readOnlyGit);

    expect(facts).toMatchObject({
      githubSlug: 'acme/app',
      defaultBranch: 'main',
      defaultSha: tip,
      headBranch: 'feat/x',
      headSha: head
    });
  });

  it('reads a detached HEAD as no branch', async () => {
    const tip = commit('a.txt');
    git(repo, 'checkout', '-q', '--detach');

    expect(await memberFacts(APP(), readOnlyGit)).toMatchObject({
      headBranch: null,
      headSha: tip
    });
  });
});
