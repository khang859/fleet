/**
 * Which branch a folder is on, as data and as words.
 *
 * Everything here is pure parsing over the contents of files git keeps in its
 * gitdir - `HEAD`, the `.git` pointer file, the marks left by an interrupted
 * rebase. Main does the reading; this decides what the bytes mean, and the
 * renderer uses the same functions to turn the result into a line of text.
 *
 * It is parsing rather than `git rev-parse` on purpose. Reading `HEAD` is about
 * 250x cheaper than spawning git, and it does not depend on a `git` being on
 * PATH - which, in a GUI-launched Electron app on macOS, is a promise nobody can
 * keep: `/usr/bin/git` is an Xcode shim that pops a modal when the command line
 * tools are missing, and that is not a thing a status line may do.
 */

/** What `HEAD` points at: a branch, or a commit with no branch on it. */
export type GitHeadRef = { kind: 'branch'; name: string } | { kind: 'detached'; sha: string };

/** A multi-step operation the repo is in the middle of. */
export type AgentGitOp = 'rebasing' | 'bisecting' | 'merging' | 'cherry-picking' | 'reverting';

/**
 * What a folder's git state comes to.
 *
 * `branch` and `sha` are not alternatives. Mid-rebase HEAD is detached *and*
 * git remembers which branch is being rebased, and that name is the useful half
 * - so both can be set, and the caller prefers the name.
 */
export type AgentGitHead = {
  /** The branch, if there is one to name. */
  branch: string | null;
  /** Short SHA, set only while HEAD points straight at a commit. */
  sha: string | null;
  /** What is half-finished in the repo, if anything. */
  op: AgentGitOp | null;
};

/** What main pushes when a pane's branch is first read, and whenever it changes. */
export type AgentGitHeadEvent = { paneId: string; head: AgentGitHead | null };

/** Git writes 40 hex digits for sha1 repos and 64 for sha256 ones. */
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

const BRANCH_PREFIX = 'refs/heads/';

/**
 * Read a `HEAD` file.
 *
 * A symref is the ordinary case; a bare object id means detached. Anything else
 * - an empty file, a half-written one - is `null` rather than a guess, because
 * showing the wrong branch is worse than showing none.
 */
export function parseHead(text: string): GitHeadRef | null {
  const line = text.trim();
  if (line.length === 0) return null;

  const symref = /^ref:\s*(\S.*)$/.exec(line);
  if (symref !== null) {
    const ref = symref[1].trim();
    if (ref.length === 0) return null;
    // Anything outside refs/heads/ is unusual enough that the raw ref says more
    // than a name carved out of it would.
    return {
      kind: 'branch',
      name: ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref
    };
  }

  return OBJECT_ID.test(line) ? { kind: 'detached', sha: line } : null;
}

/**
 * The name in a `refs/heads/...` ref, or `null` for anything else.
 *
 * Stricter than `parseHead` because its callers are the files an interrupted
 * operation leaves behind, and those hold `detached HEAD` verbatim when the
 * operation started from no branch at all. That string is not a branch name and
 * must not be rendered as one.
 */
export function branchFromRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(BRANCH_PREFIX)) return null;
  const name = trimmed.slice(BRANCH_PREFIX.length);
  return name.length === 0 ? null : name;
}

/**
 * The path out of a `.git` file.
 *
 * Both worktrees and submodules replace the `.git` directory with a file
 * holding one of these, and they differ in a way that is easy to miss: a
 * worktree's path is absolute, a submodule's is relative to the folder the file
 * is in. Resolving against that folder is correct for both, so this returns the
 * value as written and leaves joining to the caller that knows where it came
 * from.
 */
export function parseGitdirPointer(text: string): string | null {
  const match = /^gitdir:\s*(\S.*)$/m.exec(text);
  if (match === null) return null;
  const value = match[1].trim();
  return value.length === 0 ? null : value;
}

/** Enough of an object id to recognise a commit by. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Strip the characters that let a branch name lie about itself.
 *
 * Git accepts Unicode format characters in a ref name - verified, including
 * U+202E RIGHT-TO-LEFT OVERRIDE and zero-width spaces. In a status line those
 * reorder or hide the text around them, so a branch from an untrusted clone
 * could make the pane read as a different branch than it is on. Git already
 * refuses ASCII control characters, spaces and `..`, so this is the only class
 * left to remove.
 */
export function sanitizeBranch(name: string): string {
  return name.replace(/\p{Cf}/gu, '');
}

/** About as much branch as fits beside a folder name without crowding it. */
export const BRANCH_MAX_CHARS = 28;

/**
 * Shorten a long branch name from the middle.
 *
 * Tail truncation - what CSS `text-overflow` does - is the wrong half here.
 * Branch names are prefixed by convention (`feat/`, `fix/`, `release/`), so the
 * front is nearly free of information and the end is where the name actually
 * distinguishes itself. Cutting the middle keeps both.
 *
 * Counted in grapheme clusters rather than code units, so an emoji or a
 * combining mark is never sliced into a replacement character.
 */
export function truncateBranch(name: string, max = BRANCH_MAX_CHARS): string {
  const graphemes = [...new Intl.Segmenter().segment(name)].map((s) => s.segment);
  if (graphemes.length <= max) return name;
  // The odd character goes to the tail, for the same reason the cut is in the
  // middle at all: that is the end that tells two branches apart.
  const tail = Math.ceil((max - 1) / 2);
  const head = max - 1 - tail;
  return `${graphemes.slice(0, head).join('')}…${graphemes.slice(graphemes.length - tail).join('')}`;
}

/**
 * What to call the state HEAD is in: the branch when there is one, the commit
 * when there is not. Never both - the SHA is only interesting while nothing
 * better exists, and once a rebase has told us the branch it is noise.
 */
export function headName(head: AgentGitHead): string | null {
  if (head.branch !== null) return sanitizeBranch(head.branch);
  return head.sha;
}
