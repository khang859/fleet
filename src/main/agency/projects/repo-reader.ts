import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { GitRun } from '../repo-identity';

const GIT_TIMEOUT_MS = 15_000;
/** `ls-tree` of a large monorepo runs to megabytes. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Git for reading only. `core.fsmonitor` is off because a repository's own
 * config can name an fsmonitor hook, which is repository code; none of the
 * commands setup runs need the index, but this keeps it that way.
 */
export const readOnlyGit: GitRun = async (args, cwd) =>
  new Promise((done) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (err, stdout) => {
        done(err ? null : stdout.trim());
      }
    );
  });

/**
 * A file's content at a commit, byte for byte. Not through `GitRun`, which
 * trims its output: an imported file must arrive with its last newline, and
 * its hash must be the hash of what the repository holds.
 */
async function readBlob(root: string, ref: string, path: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', 'cat-file', 'blob', `${ref}:${path}`],
      { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (err, stdout) => {
        done(err ? null : stdout);
      }
    );
  });
}

/** Files of a repository at one commit, read without checking anything out. */
export type RepoReader = {
  /** What is being read: a branch name, or `working tree`. */
  readFrom: string;
  /** Every file path under `dir` (`''` for all), relative to the root, `/`-separated. */
  list: (dir: string) => string[];
  read: (path: string) => Promise<string | null>;
};

export type RepoFacts = {
  defaultBranch: string | null;
  remote: string | null;
};

async function verifies(git: GitRun, root: string, ref: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root)) !== null;
}

/** The default branch (origin's HEAD, else main or master, else the current one) and the remote. */
export async function repoFacts(root: string, git: GitRun): Promise<RepoFacts> {
  const originHead = await git(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    root
  );
  let defaultBranch = originHead?.replace(/^origin\//, '') ?? null;
  if (defaultBranch === null) {
    for (const name of ['main', 'master']) {
      if (await verifies(git, root, `refs/heads/${name}`)) {
        defaultBranch = name;
        break;
      }
    }
  }
  defaultBranch ??= await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  const origin = await git(['remote', 'get-url', 'origin'], root);
  const first = origin ?? (await git(['remote'], root))?.split('\n')[0] ?? null;
  const remote =
    origin ??
    (first === null || first === '' ? null : await git(['remote', 'get-url', first], root));
  return { defaultBranch: defaultBranch === '' ? null : defaultBranch, remote };
}

function under(files: string[], dir: string): string[] {
  if (dir === '') return files;
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return files.filter((f) => f.startsWith(prefix));
}

/**
 * A reader for the default branch tip, from git's object store. A repository
 * with no commit on it yet is read from its working tree instead.
 */
export async function openRepoReader(
  root: string,
  defaultBranch: string | null,
  git: GitRun
): Promise<RepoReader> {
  let ref: string | null = null;
  if (defaultBranch !== null) {
    for (const candidate of [
      `refs/heads/${defaultBranch}`,
      `refs/remotes/origin/${defaultBranch}`
    ]) {
      if (await verifies(git, root, candidate)) {
        ref = candidate;
        break;
      }
    }
  }
  if (ref !== null) {
    const tree = await git(['ls-tree', '-r', '--name-only', '-z', ref], root);
    const files = (tree ?? '').split('\0').filter((f) => f !== '');
    const known = new Set(files);
    const at = ref;
    return {
      readFrom: defaultBranch ?? at,
      list: (dir) => under(files, dir),
      read: async (path) => (known.has(path) ? readBlob(root, at, path) : null)
    };
  }
  return workingTreeReader(root);
}

async function workingTreeReader(root: string): Promise<RepoReader> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
    .filter((f) => !f.startsWith('.git/') && !f.includes('node_modules/'));
  const known = new Set(files);
  return {
    readFrom: 'working tree',
    list: (dir) => under(files, dir),
    read: async (path) =>
      known.has(path) ? readFile(join(root, path), 'utf8').catch(() => null) : null
  };
}
