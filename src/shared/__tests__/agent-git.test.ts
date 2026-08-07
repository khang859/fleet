import { describe, expect, it } from 'vitest';
import {
  BRANCH_MAX_CHARS,
  branchFromRef,
  headName,
  parseGitdirPointer,
  parseHead,
  sanitizeBranch,
  shortSha,
  truncateBranch
} from '../agent-git';

describe('parseHead', () => {
  it('reads an ordinary branch', () => {
    expect(parseHead('ref: refs/heads/main\n')).toEqual({ kind: 'branch', name: 'main' });
  });

  it('keeps the slashes in a namespaced branch', () => {
    expect(parseHead('ref: refs/heads/feat/agent\n')).toEqual({
      kind: 'branch',
      name: 'feat/agent'
    });
  });

  // The whole reason this reads the file rather than shelling out: on an unborn
  // branch `git rev-parse --abbrev-ref HEAD` fails *and* prints the word HEAD,
  // so the obvious implementation shows a fresh repo as being on a branch
  // called HEAD. The file has said `main` all along.
  it('names the branch of a repo with no commits yet', () => {
    expect(parseHead('ref: refs/heads/main\n')).toEqual({ kind: 'branch', name: 'main' });
  });

  it('reads a detached sha1 head', () => {
    const sha = '4f2a91b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2';
    expect(parseHead(`${sha}\n`)).toEqual({ kind: 'detached', sha });
  });

  it('reads a detached sha256 head', () => {
    const sha = 'a'.repeat(64);
    expect(parseHead(`${sha}\n`)).toEqual({ kind: 'detached', sha });
  });

  it('keeps a symref that is not under refs/heads as written', () => {
    expect(parseHead('ref: refs/remotes/origin/main\n')).toEqual({
      kind: 'branch',
      name: 'refs/remotes/origin/main'
    });
  });

  it('refuses to guess at an empty or half-written file', () => {
    expect(parseHead('')).toBeNull();
    expect(parseHead('   \n')).toBeNull();
    expect(parseHead('ref:\n')).toBeNull();
    expect(parseHead('not a sha and not a ref')).toBeNull();
    expect(parseHead('4f2a91b')).toBeNull();
  });
});

describe('branchFromRef', () => {
  it('takes the name out of a refs/heads ref', () => {
    expect(branchFromRef('refs/heads/feature\n')).toBe('feature');
  });

  // What a rebase started from no branch at all writes into head-name. It is
  // not a branch name and must never be rendered as one.
  it('rejects the literal detached HEAD marker', () => {
    expect(branchFromRef('detached HEAD')).toBeNull();
  });

  it('rejects anything else', () => {
    expect(branchFromRef('refs/tags/v1')).toBeNull();
    expect(branchFromRef('refs/heads/')).toBeNull();
    expect(branchFromRef('')).toBeNull();
  });
});

describe('parseGitdirPointer', () => {
  // A worktree's pointer is absolute...
  it('reads a worktree pointer', () => {
    expect(parseGitdirPointer('gitdir: /Users/k/dev/fleet/.git/worktrees/wt\n')).toBe(
      '/Users/k/dev/fleet/.git/worktrees/wt'
    );
  });

  // ...and a submodule's is relative to the folder the file is in. Returning it
  // as written is what lets the caller resolve both against that folder.
  it('reads a submodule pointer, relative and unresolved', () => {
    expect(parseGitdirPointer('gitdir: ../.git/modules/sub\n')).toBe('../.git/modules/sub');
  });

  it('keeps spaces in the path', () => {
    expect(parseGitdirPointer('gitdir: /Users/k/My Repos/app/.git\n')).toBe(
      '/Users/k/My Repos/app/.git'
    );
  });

  it('answers null when there is no pointer', () => {
    expect(parseGitdirPointer('')).toBeNull();
    expect(parseGitdirPointer('gitdir:\n')).toBeNull();
    expect(parseGitdirPointer('ref: refs/heads/main\n')).toBeNull();
  });
});

describe('sanitizeBranch', () => {
  // Git accepts these, and in a status line they reorder or hide the text
  // around them - so a branch from an untrusted clone could make the pane read
  // as a branch it is not on.
  it('strips a right-to-left override', () => {
    expect(sanitizeBranch('feat/‮gnp.txt')).toBe('feat/gnp.txt');
  });

  it('strips zero-width characters', () => {
    expect(sanitizeBranch('ma​in')).toBe('main');
  });

  it('leaves ordinary and non-latin names alone', () => {
    expect(sanitizeBranch('feat/agent')).toBe('feat/agent');
    expect(sanitizeBranch('fix/héllo-ünicode')).toBe('fix/héllo-ünicode');
    expect(sanitizeBranch('feat/عربي-test')).toBe('feat/عربي-test');
  });
});

describe('truncateBranch', () => {
  it('leaves a name that fits', () => {
    expect(truncateBranch('feat/agent')).toBe('feat/agent');
  });

  // The end is where a branch name distinguishes itself - the front is a
  // convention prefix - so the cut comes out of the middle, not the tail.
  it('takes the middle out of a long name, keeping both ends', () => {
    const long = 'feat/some-extremely-long-descriptive-name-2026';
    const short = truncateBranch(long);
    expect(short).toHaveLength(BRANCH_MAX_CHARS);
    expect(short).toContain('…');
    expect(short.startsWith('feat/some-')).toBe(true);
    expect(short.endsWith('-name-2026')).toBe(true);
  });

  it('respects a custom budget', () => {
    expect(truncateBranch('abcdefghij', 5)).toBe('ab…ij');
  });

  // Counted in graphemes: slicing by code unit turns an emoji into a pair of
  // replacement characters.
  it('never splits an emoji', () => {
    const name = `feat/${'🚀'.repeat(20)}`;
    const short = truncateBranch(name);
    expect(short).not.toContain('�');
    expect(short.includes('\uD83D') && !short.includes('🚀')).toBe(false);
  });
});

describe('headName', () => {
  it('prefers the branch', () => {
    expect(headName({ branch: 'main', sha: null, op: null })).toBe('main');
  });

  // Mid-rebase HEAD is detached and git still knows the branch. The name is the
  // useful half; the commit it happens to be parked on is not.
  it('prefers the branch a rebase remembers over the commit', () => {
    expect(headName({ branch: 'feature', sha: '4f2a91b', op: 'rebasing' })).toBe('feature');
  });

  it('falls back to the commit when nothing names it', () => {
    expect(headName({ branch: null, sha: '4f2a91b', op: null })).toBe('4f2a91b');
  });

  it('sanitizes the branch on the way out', () => {
    expect(headName({ branch: 'ma​in', sha: null, op: null })).toBe('main');
  });

  it('answers null when there is nothing to show', () => {
    expect(headName({ branch: null, sha: null, op: null })).toBeNull();
  });
});

describe('shortSha', () => {
  it('takes enough to recognise a commit by', () => {
    expect(shortSha('4f2a91b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2')).toBe('4f2a91b');
  });
});
