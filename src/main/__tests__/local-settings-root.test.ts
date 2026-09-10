import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveLocalSettingsRoot } from '../claude-config/local-settings-root';

/**
 * These run real `git` against temp repositories. The worktree case is the
 * whole reason this resolver exists, and it cannot be exercised with a stub
 * without reimplementing the behaviour under test.
 */

let base: string;
let repo: string;
let worktree: string;
let plain: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeAll(() => {
  // realpath: macOS temp dirs are symlinks, and git reports resolved paths.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-lsr-')));

  repo = join(base, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');

  worktree = join(base, 'app-feature');
  git(repo, 'worktree', 'add', worktree, '-b', 'feature');

  plain = join(base, 'not-a-repo');
  mkdirSync(plain);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveLocalSettingsRoot', () => {
  it('gives the repository root for a directory inside a plain repository', async () => {
    const nested = join(repo, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    const result = await resolveLocalSettingsRoot(nested);
    expect(result).toEqual({ root: repo, rule: 'repositoryRoot' });
  });

  it('gives the repository root when the session directory is the root', async () => {
    const result = await resolveLocalSettingsRoot(repo);
    expect(result).toEqual({ root: repo, rule: 'repositoryRoot' });
  });

  it('gives the MAIN checkout root from inside a worktree, not the worktree root', async () => {
    const result = await resolveLocalSettingsRoot(worktree);
    expect(result.root).toBe(repo);
    expect(result.root).not.toBe(worktree);
    expect(result.rule).toBe('worktreeMainCheckout');
  });

  it('gives the main checkout root from a subdirectory of a worktree', async () => {
    const nested = join(worktree, 'src');
    mkdirSync(nested, { recursive: true });
    const result = await resolveLocalSettingsRoot(nested);
    expect(result).toEqual({ root: repo, rule: 'worktreeMainCheckout' });
  });

  it('falls back to the session directory outside a repository', async () => {
    const result = await resolveLocalSettingsRoot(plain);
    expect(result).toEqual({ root: plain, rule: 'sessionDirectory' });
  });

  it('falls back to the session directory for a path that does not exist', async () => {
    const missing = join(base, 'nope', 'gone');
    const result = await resolveLocalSettingsRoot(missing);
    expect(result).toEqual({ root: missing, rule: 'sessionDirectory' });
  });
});
