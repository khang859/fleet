import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorktreeService } from '../worktree-service';
import { isIgnored, parseWorktreeSetup } from '../worktree-config';
import type * as FleetHome from '../../shared/fleet-home';

/** Real git in a temp folder: the new-worktree dialog's branches, setup file and copied files. */

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

function write(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

/** Writes each file into the repository and commits them together. */
function commitFiles(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) write(path, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'files');
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-wt-setup-')));
  repo = join(dir, 'app');
  paths.fleetHome = join(dir, '.fleet');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('WorktreeService.prepare', () => {
  it('lists the current branch, local branches first, and the setup file', async () => {
    commitFiles({ '.fleet/worktree.toml': 'setup = "npm install"\ncopy = [".env"]\n' });
    git(repo, 'branch', 'feature');

    const info = await new WorktreeService().prepare(repo);

    expect(info.current).toBe('main');
    expect(info.refs).toEqual(expect.arrayContaining(['main', 'feature']));
    expect(info.setup).toEqual({ setup: 'npm install', copy: ['.env'] });
    expect(info.setupError).toBeNull();
  });

  it('has no setup and no error when the repository has no setup file', async () => {
    commitFiles({ 'a.txt': 'a' });

    const info = await new WorktreeService().prepare(repo);

    expect(info.setup).toBeNull();
    expect(info.setupError).toBeNull();
  });

  it('says what is wrong with a broken setup file', async () => {
    commitFiles({ '.fleet/worktree.toml': 'setpu = "npm install"\n' });

    const info = await new WorktreeService().prepare(repo);

    expect(info.setup).toBeNull();
    expect(info.setupError).toContain('.fleet/worktree.toml');
    expect(info.setupError).toContain('setpu');
  });
});

describe('WorktreeService.copyFromMain', () => {
  it('copies ignored files and folders, and skips what git tracks or does not ignore', async () => {
    commitFiles({
      '.gitignore': '.env\n.cache/\n',
      '.fleet/worktree.toml':
        'copy = [".env", "apps/web/.env", ".cache/", "README.md", "notes.txt", "missing.env"]\n',
      'README.md': 'tracked'
    });
    write('.env', 'SECRET=1');
    write('apps/web/.env', 'WEB=1');
    write('.cache/data/blob.bin', 'cached');
    write('notes.txt', 'untracked but not ignored');

    const service = new WorktreeService();
    const made = await service.create(repo);
    const result = await service.copyFromMain(repo, made.worktreePath);

    expect(result.copied).toEqual(['.env', 'apps/web/.env', '.cache']);
    expect(result.skipped).toEqual([
      { path: 'README.md', reason: 'git does not ignore it' },
      { path: 'notes.txt', reason: 'git does not ignore it' },
      { path: 'missing.env', reason: 'not in the main checkout' }
    ]);
    expect(readFileSync(join(made.worktreePath, '.env'), 'utf8')).toBe('SECRET=1');
    expect(readFileSync(join(made.worktreePath, 'apps/web/.env'), 'utf8')).toBe('WEB=1');
    expect(existsSync(join(made.worktreePath, '.cache/data/blob.bin'))).toBe(true);
    expect(readFileSync(join(made.worktreePath, 'README.md'), 'utf8')).toBe('tracked');
  });

  it('never overwrites a file the worktree already has', async () => {
    commitFiles({ '.gitignore': '.env\n', '.fleet/worktree.toml': 'copy = [".env"]\n' });
    write('.env', 'MAIN=1');

    const service = new WorktreeService();
    const made = await service.create(repo);
    writeFileSync(join(made.worktreePath, '.env'), 'OWN=1');
    const result = await service.copyFromMain(repo, made.worktreePath);

    expect(result.skipped).toEqual([{ path: '.env', reason: 'the worktree already has it' }]);
    expect(readFileSync(join(made.worktreePath, '.env'), 'utf8')).toBe('OWN=1');
  });
});

describe('parseWorktreeSetup', () => {
  it('trims the setup and normalizes copy paths', () => {
    expect(
      parseWorktreeSetup('setup = """\nnpm install\n"""\ncopy = ["./.env", "a/", ".env"]')
    ).toEqual({ setup: 'npm install', copy: ['.env', 'a'] });
  });

  it('refuses paths outside the repository or inside .git', () => {
    for (const path of ['../x', '/etc/passwd', '.git/config', 'a/../../b', 'a\\\\b']) {
      expect(() => parseWorktreeSetup(`copy = ["${path}"]`), path).toThrow();
    }
  });

  it('refuses unknown keys', () => {
    expect(() => parseWorktreeSetup('setpu = "x"')).toThrow(/setpu/);
  });
});

describe('isIgnored', () => {
  it('matches a path, or one inside a wholly ignored folder', () => {
    expect(isIgnored('.env', ['.env'])).toBe(true);
    expect(isIgnored('.cache', ['.cache/'])).toBe(true);
    expect(isIgnored('.cache/data/x', ['.cache/'])).toBe(true);
    expect(isIgnored('.cachex', ['.cache/'])).toBe(false);
    expect(isIgnored('.env.local', ['.env'])).toBe(false);
  });
});
