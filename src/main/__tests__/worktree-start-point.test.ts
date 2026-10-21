import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeService } from '../worktree-service';
import type * as FleetHome from '../../shared/fleet-home';

/** Real git in a temp folder: worktrees made apart from one pinned commit start alike. */

let dir: string;
let repo: string;

const paths = vi.hoisted(() => ({ fleetHome: '' }));

// Worktrees go under FLEET_HOME/worktrees; keep them in the temp folder.
vi.mock('../../shared/fleet-home', async (importOriginal) => ({
  ...(await importOriginal<typeof FleetHome>()),
  get FLEET_HOME(): string {
    return paths.fleetHome;
  }
}));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

function commit(name: string): string {
  writeFileSync(join(repo, name), name);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', name);
  return git(repo, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-wt-start-')));
  repo = join(dir, 'app');
  paths.fleetHome = join(dir, '.fleet');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('WorktreeService start point', () => {
  it('starts two worktrees made apart from the same pinned commit', async () => {
    const service = new WorktreeService();
    const pin = commit('a.txt');

    const first = await service.create(repo, undefined, 'admiral/1/builder-1', pin);
    // The client moves on in between: main advances and HEAD is on another branch.
    commit('b.txt');
    git(repo, 'checkout', '-q', '-b', 'elsewhere');
    commit('c.txt');
    const second = await service.create(repo, undefined, 'admiral/1/builder-2', pin);

    expect(git(first.worktreePath, 'rev-parse', 'HEAD')).toBe(pin);
    expect(git(second.worktreePath, 'rev-parse', 'HEAD')).toBe(pin);
    expect(git(second.worktreePath, 'branch', '--show-current')).toBe('admiral/1/builder-2');
  });

  it('refuses a start point that is not a commit and makes nothing', async () => {
    const service = new WorktreeService();
    commit('a.txt');

    await expect(
      service.create(repo, undefined, 'admiral/1/builder-1', 'f'.repeat(40))
    ).rejects.toThrow();
    expect(existsSync(join(dir, '.fleet', 'worktrees', 'app', 'admiral-1-builder-1'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'admiral/*')).toBe('');
  });

  it('starts from the main checkout HEAD without a start point', async () => {
    const service = new WorktreeService();
    commit('a.txt');
    const head = commit('b.txt');

    const made = await service.create(repo, undefined, 'plain');

    expect(git(made.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
  });
});
