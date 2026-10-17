import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepoIdentity, repoIdFor } from '../repo-identity';

/**
 * Real repositories in a temp dir: a main checkout with a linked worktree and
 * a submodule, and a plain folder beside them. The ids must agree with what
 * git itself says, not with a fake of it.
 */
let base: string;
let main: string;
let worktree: string;
let library: string;
let plain: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null'
    }
  }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

beforeAll(() => {
  // realpath: on macOS the temp dir sits behind the /var -> /private/var link.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-repo-id-')));
  main = join(base, 'fleet');
  library = join(base, 'library');
  worktree = join(base, 'fleet-wt');
  plain = join(base, 'plain');
  initRepo(main);
  initRepo(library);
  mkdirSync(join(main, 'src', 'deep'), { recursive: true });
  git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  git(
    main,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    library,
    'vendor/library'
  );
  mkdirSync(plain);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveRepoIdentity', () => {
  it('names a repository by its common dir, from its root or any folder inside', async () => {
    const atRoot = await resolveRepoIdentity(main);
    expect(atRoot).toEqual({
      ok: true,
      repoId: repoIdFor(join(main, '.git')),
      root: main,
      name: 'fleet',
      gitCommonDir: join(main, '.git'),
      superprojectRoot: null,
      superprojectRepoId: null
    });
    expect(await resolveRepoIdentity(join(main, 'src', 'deep'))).toEqual(atRoot);
  });

  it('resolves a linked worktree to the main checkout', async () => {
    const fromMain = await resolveRepoIdentity(main);
    const fromWorktree = await resolveRepoIdentity(worktree);
    expect(fromWorktree).toEqual(fromMain);
  });

  it('treats a submodule as its own repository and names its superproject', async () => {
    const parent = await resolveRepoIdentity(main);
    const sub = await resolveRepoIdentity(join(main, 'vendor', 'library'));
    expect(sub.ok && parent.ok).toBe(true);
    if (!sub.ok || !parent.ok) return;
    expect(sub.repoId).not.toBe(parent.repoId);
    expect(sub.root).toBe(join(main, 'vendor', 'library'));
    expect(sub.name).toBe('library');
    expect(sub.gitCommonDir).toBe(join(main, '.git', 'modules', 'vendor', 'library'));
    expect(sub.superprojectRoot).toBe(main);
    expect(sub.superprojectRepoId).toBe(parent.repoId);
  });

  it('refuses a folder outside any repository, and one that does not exist', async () => {
    expect(await resolveRepoIdentity(plain)).toEqual({ ok: false, reason: 'not-a-repo' });
    expect(await resolveRepoIdentity(join(base, 'missing'))).toEqual({
      ok: false,
      reason: 'not-a-repo'
    });
  });

  it('refuses a remote folder without running git', async () => {
    let ran = false;
    const spy = async (): Promise<string | null> => {
      ran = true;
      return Promise.resolve(null);
    };
    expect(await resolveRepoIdentity(main, { remote: true, git: spy })).toEqual({
      ok: false,
      reason: 'remote'
    });
    expect(await resolveRepoIdentity('\\\\server\\share\\repo', { git: spy })).toEqual({
      ok: false,
      reason: 'remote'
    });
    expect(await resolveRepoIdentity('//server/share/repo', { git: spy })).toEqual({
      ok: false,
      reason: 'remote'
    });
    expect(ran).toBe(false);
  });
});
