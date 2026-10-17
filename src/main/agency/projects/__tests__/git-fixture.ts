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

const pkg = (name: string, deps: string[] = []): string =>
  JSON.stringify({ name, dependencies: Object.fromEntries(deps.map((d) => [d, '*'])) });

/**
 * `shop` in `home`, an umbrella with `web`, `api` and `core` in `.gitmodules`
 * in that order, at `libs/<name>`, where web needs api and core, and api
 * needs core. Returns the umbrella's root.
 */
export function shopUmbrella(home: string): string {
  const src = join(home, 'src');
  const repos = {
    web: pkg('@shop/web', ['@shop/api', '@shop/core']),
    api: pkg('@shop/api', ['@shop/core']),
    core: pkg('@shop/core')
  };
  const root = initRepo(join(home, 'shop'), { 'README.md': '# Shop\n' });
  for (const [name, text] of Object.entries(repos)) {
    initRepo(join(src, name), { 'package.json': text, 'CLAUDE.md': `# ${name}\n` });
    git(
      root,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      join(src, name),
      `libs/${name}`
    );
  }
  git(root, 'commit', '-q', '-m', 'members');
  return root;
}

/** `work` in `home`, a plain folder of the repositories `app` and `lib`, where app needs lib. */
export function workFolder(home: string): string {
  const root = join(home, 'work');
  initRepo(join(root, 'app'), { 'package.json': pkg('app', ['lib']) });
  initRepo(join(root, 'lib'), { 'package.json': pkg('lib') });
  return root;
}
