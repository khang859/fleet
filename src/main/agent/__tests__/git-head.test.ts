import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGitHeadAt, resolveGitDir } from '../git-head';

/**
 * The gitdirs here are hand-built rather than produced by running git.
 *
 * What is under test is the reading of those files, so writing them directly is
 * both hermetic - no dependency on a git being installed, or on its version -
 * and the only way to pin the awkward shapes: a `git am` that leaves a
 * rebase-apply directory with no head-name in it, a bisect started from a
 * detached HEAD. The contents themselves were taken from a real repo in each of
 * these states.
 */

let root: string;

beforeEach(() => {
  // realpath because macOS hands out /var/folders paths that are really
  // /private/var - the same discrepancy /tmp has, and the reason resolveGitDir
  // realpaths its input at all.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-git-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A gitdir with the given HEAD, plus whatever else the test needs in it. */
function makeRepo(name: string, head: string): string {
  const repo = join(root, name);
  const gitDir = join(repo, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), head);
  return repo;
}

describe('resolveGitDir', () => {
  it('finds the gitdir of the repo root', async () => {
    const repo = makeRepo('plain', 'ref: refs/heads/main\n');
    expect(await resolveGitDir(repo)).toBe(join(repo, '.git'));
  });

  it('walks up from a subdirectory', async () => {
    const repo = makeRepo('nested', 'ref: refs/heads/main\n');
    const deep = join(repo, 'src', 'components', 'agent');
    mkdirSync(deep, { recursive: true });
    expect(await resolveGitDir(deep)).toBe(join(repo, '.git'));
  });

  it('answers null for a folder that is not in a repo', async () => {
    const plain = join(root, 'downloads');
    mkdirSync(plain);
    expect(await resolveGitDir(plain)).toBeNull();
  });

  it('answers null for a folder that does not exist', async () => {
    expect(await resolveGitDir(join(root, 'gone'))).toBeNull();
  });

  // A worktree replaces .git with a file, and its pointer is absolute.
  it('follows a worktree pointer', async () => {
    const main = makeRepo('main-repo', 'ref: refs/heads/main\n');
    const worktreeGitDir = join(main, '.git', 'worktrees', 'wt');
    mkdirSync(worktreeGitDir, { recursive: true });

    const worktree = join(root, 'wt');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);

    expect(await resolveGitDir(worktree)).toBe(worktreeGitDir);
  });

  // A submodule replaces .git with a file too, but its pointer is *relative* to
  // the folder holding it. Resolving it against the process cwd instead - the
  // easy mistake - silently reports the superproject's branch.
  it('follows a submodule pointer relative to the folder holding it', async () => {
    const superproject = makeRepo('super', 'ref: refs/heads/main\n');
    const moduleGitDir = join(superproject, '.git', 'modules', 'sub');
    mkdirSync(moduleGitDir, { recursive: true });

    const submodule = join(superproject, 'sub');
    mkdirSync(submodule);
    writeFileSync(join(submodule, '.git'), 'gitdir: ../.git/modules/sub\n');

    expect(await resolveGitDir(submodule)).toBe(moduleGitDir);
  });

  it('answers null for a .git file that points nowhere', async () => {
    const broken = join(root, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, '.git'), 'not a pointer\n');
    expect(await resolveGitDir(broken)).toBeNull();
  });
});

describe('readGitHeadAt', () => {
  it('reads an ordinary branch', async () => {
    const repo = makeRepo('plain', 'ref: refs/heads/feat/agent\n');
    expect(await readGitHeadAt(repo)).toEqual({ branch: 'feat/agent', sha: null, op: null });
  });

  // A repo with no commits: HEAD is a symref to a branch that does not exist
  // yet. The branch is still the right thing to show.
  it('names the branch of a repo with no commits yet', async () => {
    const repo = makeRepo('unborn', 'ref: refs/heads/main\n');
    expect(await readGitHeadAt(repo)).toEqual({ branch: 'main', sha: null, op: null });
  });

  it('shortens the commit of a detached head', async () => {
    const repo = makeRepo('detached', `${'4f2a91b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2'}\n`);
    expect(await readGitHeadAt(repo)).toEqual({ branch: null, sha: '4f2a91b', op: null });
  });

  it('answers null for a folder that is not a repo', async () => {
    const plain = join(root, 'downloads');
    mkdirSync(plain);
    expect(await readGitHeadAt(plain)).toBeNull();
  });

  it('answers null when HEAD says nothing usable', async () => {
    const repo = makeRepo('empty-head', '');
    expect(await readGitHeadAt(repo)).toBeNull();
  });

  describe('an operation in progress', () => {
    it('recovers the branch being rebased, though HEAD is detached', async () => {
      const repo = makeRepo('rebasing', `${'a'.repeat(40)}\n`);
      const rebase = join(repo, '.git', 'rebase-merge');
      mkdirSync(rebase);
      writeFileSync(join(rebase, 'head-name'), 'refs/heads/feature\n');

      expect(await readGitHeadAt(repo)).toEqual({
        branch: 'feature',
        sha: 'aaaaaaa',
        op: 'rebasing'
      });
    });

    it('handles the older rebase backend', async () => {
      const repo = makeRepo('rebasing-apply', `${'b'.repeat(40)}\n`);
      const rebase = join(repo, '.git', 'rebase-apply');
      mkdirSync(rebase);
      writeFileSync(join(rebase, 'head-name'), 'refs/heads/feature\n');

      expect((await readGitHeadAt(repo))?.op).toBe('rebasing');
    });

    // `git am` shares the rebase-apply directory but writes no head-name, and
    // does not detach HEAD. Reading the file without checking it is there is
    // how a perfectly ordinary branch ends up captioned `undefined (rebasing)`.
    it('does not mistake a conflicted git am for a rebase', async () => {
      const repo = makeRepo('am', 'ref: refs/heads/main\n');
      mkdirSync(join(repo, '.git', 'rebase-apply'));

      expect(await readGitHeadAt(repo)).toEqual({ branch: 'main', sha: null, op: null });
    });

    it('recovers the branch bisecting started from', async () => {
      const repo = makeRepo('bisecting', `${'c'.repeat(40)}\n`);
      writeFileSync(join(repo, '.git', 'BISECT_START'), 'main\n');

      expect(await readGitHeadAt(repo)).toEqual({
        branch: 'main',
        sha: 'ccccccc',
        op: 'bisecting'
      });
    });

    it('leaves a bisect started from no branch to the commit', async () => {
      const repo = makeRepo('bisect-detached', `${'d'.repeat(40)}\n`);
      writeFileSync(join(repo, '.git', 'BISECT_START'), `${'e'.repeat(40)}\n`);

      expect(await readGitHeadAt(repo)).toEqual({
        branch: null,
        sha: 'ddddddd',
        op: 'bisecting'
      });
    });

    // These three leave HEAD on its branch, so they only add the suffix.
    it.each([
      ['MERGE_HEAD', 'merging'],
      ['CHERRY_PICK_HEAD', 'cherry-picking'],
      ['REVERT_HEAD', 'reverting']
    ])('reports %s as %s, still on the branch', async (marker, op) => {
      const repo = makeRepo(`op-${marker}`, 'ref: refs/heads/main\n');
      writeFileSync(join(repo, '.git', marker), `${'f'.repeat(40)}\n`);

      expect(await readGitHeadAt(repo)).toEqual({ branch: 'main', sha: null, op });
    });
  });
});
