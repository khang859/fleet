import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  branchFromRef,
  parseGitdirPointer,
  parseHead,
  shortSha,
  type AgentGitHead,
  type AgentGitOp
} from '../../shared/agent-git';

/**
 * Finding a folder's gitdir and reading what branch it is on, off the disk.
 *
 * No subprocess: see the note in `shared/agent-git.ts` for why. The practical
 * consequence is that everything here is a file read that either works or comes
 * back `null`, so there is no timeout, no PATH, no lock contention and no
 * argument to quote. A folder that is not a repo is not an error - it is the
 * common case for a pane opened on a downloads folder, and it answers `null`.
 */

/**
 * How far up to look for a `.git`. Deep enough for any real checkout, and a
 * bound on the walk: the path has been through `realpath`, but a cap is what
 * keeps a pathological mount from turning this into an unbounded loop.
 */
const MAX_WALK_DEPTH = 40;

/**
 * Every file read here is a line or two. The cap is what stops a `.git` file
 * that is really a gigabyte of something else from being pulled into memory.
 */
const MAX_BYTES = 4096;

async function readCapped(path: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(path, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The gitdir governing a folder, or `null` if it is not in a repo.
 *
 * Walks up, because a pane is as likely to be opened on `repo/src/components`
 * as on the root. The path is realpath'd first so that a symlinked folder - or
 * `/tmp` on macOS, which is really `/private/tmp` - resolves to the same gitdir
 * as the real one, which is what lets two panes on the same repo share a
 * watcher.
 *
 * A `.git` that is a file rather than a directory is a worktree or a submodule.
 * The pointer inside is absolute for the first and relative for the second, so
 * it is resolved against the folder holding it: correct either way, and getting
 * this wrong silently reports the superproject's branch for a submodule.
 */
export async function resolveGitDir(cwd: string): Promise<string | null> {
  let dir: string;
  try {
    dir = await fs.realpath(cwd);
  } catch {
    return null;
  }

  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const candidate = join(dir, '.git');
    const stat = await fs.stat(candidate).catch(() => null);

    if (stat?.isDirectory() === true) return candidate;
    if (stat?.isFile() === true) {
      const raw = await readCapped(candidate);
      const pointer = raw === null ? null : parseGitdirPointer(raw);
      return pointer === null ? null : resolve(dir, pointer);
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * The operation the repo is part-way through, and the branch it concerns.
 *
 * Order matters: a rebase both detaches HEAD and records the branch it started
 * from, so it has to be consulted before the SHA is accepted as the answer.
 *
 * The `rebase-apply` case is shared with `git am`, which leaves the directory
 * behind but writes no `head-name` and does not detach HEAD at all. A missing
 * file there means "not a rebase", not "a rebase of nothing" - reading it
 * without checking is how the caption ends up saying `undefined (rebasing)`
 * over a perfectly ordinary branch.
 */
async function readOperation(
  gitDir: string
): Promise<{ op: AgentGitOp; branch: string | null } | null> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const headName = await readCapped(join(gitDir, dir, 'head-name'));
    if (headName !== null) return { op: 'rebasing', branch: branchFromRef(headName) };
  }

  // Holds the branch bisecting started from - or a bare commit, when it started
  // from none, which is not a name and is left to the SHA to report.
  const bisect = await readCapped(join(gitDir, 'BISECT_START'));
  if (bisect !== null) {
    const start = bisect.trim();
    return { op: 'bisecting', branch: /^[0-9a-f]{7,}$/i.test(start) ? null : start || null };
  }

  // These three leave HEAD on its branch, so they only ever add the suffix.
  if (await exists(join(gitDir, 'MERGE_HEAD'))) return { op: 'merging', branch: null };
  if (await exists(join(gitDir, 'CHERRY_PICK_HEAD'))) return { op: 'cherry-picking', branch: null };
  if (await exists(join(gitDir, 'REVERT_HEAD'))) return { op: 'reverting', branch: null };

  return null;
}

/** What a gitdir's `HEAD` says, with whatever operation is running folded in. */
export async function readGitHead(gitDir: string): Promise<AgentGitHead | null> {
  const raw = await readCapped(join(gitDir, 'HEAD'));
  if (raw === null) return null;
  const ref = parseHead(raw);
  if (ref === null) return null;

  const operation = await readOperation(gitDir);
  const op = operation?.op ?? null;

  // A repo with no commits yet still has a symref, which is why this reads the
  // file rather than asking git: `rev-parse --abbrev-ref HEAD` fails on an
  // unborn branch *and* prints the word `HEAD`, so the naive version of this
  // renders a repo you have just created as being on a branch called HEAD.
  if (ref.kind === 'branch') return { branch: ref.name, sha: null, op };

  return { branch: operation?.branch ?? null, sha: shortSha(ref.sha), op };
}

/** The same, starting from a folder rather than a gitdir. */
export async function readGitHeadAt(cwd: string): Promise<AgentGitHead | null> {
  const gitDir = await resolveGitDir(cwd);
  return gitDir === null ? null : readGitHead(gitDir);
}
