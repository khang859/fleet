import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GhRun } from '../gh';

/** Real git repositories in a temp dir, for setup's read-only scans to read. */

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null'
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: ENV,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/** A temp dir, realpath'd: on macOS it sits behind the /var -> /private/var link. */
export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A repository on `main` with `files` committed, and `origin` set when given. */
export function initRepo(
  dir: string,
  files: Record<string, string>,
  opts: { origin?: string } = {}
): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  if (opts.origin !== undefined) git(dir, 'remote', 'add', 'origin', opts.origin);
  return dir;
}

/** A GitHub CLI that answers from `answer`; null is a `gh` that is not installed. */
export function fakeGh(answer: (args: string[]) => { code: number; stdout: string } | null): GhRun {
  return async (args) => Promise.resolve(answer(args));
}
