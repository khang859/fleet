import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  prepareWorkspace,
  cleanupWorkspace,
  removeWorktree,
  mergeWorktreeToBase
} from '../kanban/workspace';

const ROOT = join(tmpdir(), `fleet-kanban-ws-test-${process.pid}`);
const WT_ROOT = join(ROOT, 'worktrees');

function makeRepo(name: string): string {
  const repo = join(ROOT, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}

describe('kanban workspace', () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it('creates a scratch dir under the root', () => {
    const { path, branchName } = prepareWorkspace({
      kind: 'scratch',
      taskId: 'abc',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT
    });
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(ROOT)).toBe(true);
    expect(branchName).toBeNull();
  });

  it('cleans up a scratch dir', () => {
    const { path } = prepareWorkspace({
      kind: 'scratch',
      taskId: 'abc',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT
    });
    cleanupWorkspace({ kind: 'scratch', path });
    expect(existsSync(path)).toBe(false);
  });

  it('returns the explicit path for dir kind', () => {
    const dir = join(ROOT, 'explicit');
    mkdirSync(dir);
    const { path, branchName } = prepareWorkspace({
      kind: 'dir',
      taskId: 'abc',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      workspacePath: dir
    });
    expect(path).toBe(dir);
    expect(branchName).toBeNull();
  });

  it('does not delete a dir-kind workspace on cleanup', () => {
    const keep = join(ROOT, 'keep');
    mkdirSync(keep);
    cleanupWorkspace({ kind: 'dir', path: keep });
    expect(existsSync(keep)).toBe(true);
  });

  it('creates a worktree on kanban/<taskId> from the source repo', () => {
    const repo = makeRepo('repo1');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 't1',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    expect(path).toBe(join(WT_ROOT, 't1'));
    expect(existsSync(path)).toBe(true);
    expect(branchName).toBe('kanban/t1');
    const branch = execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8'
    }).trim();
    expect(branch).toBe('kanban/t1');
  });

  it('reuses an existing worktree without re-creating it', () => {
    const repo = makeRepo('repo2');
    const first = prepareWorkspace({
      kind: 'worktree',
      taskId: 't2',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    const second = prepareWorkspace({
      kind: 'worktree',
      taskId: 't2',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo,
      workspacePath: first.path,
      branchName: first.branchName ?? undefined
    });
    expect(second.path).toBe(first.path);
    expect(second.branchName).toBe('kanban/t2');
  });

  it('attaches to an already-existing branch instead of failing', () => {
    const repo = makeRepo('repo3');
    execFileSync('git', ['-C', repo, 'branch', 'kanban/t3']);
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 't3',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    expect(existsSync(path)).toBe(true);
    expect(branchName).toBe('kanban/t3');
  });

  it('recovers on a later attempt after a failed worktree add left a dir behind', () => {
    const repo = makeRepo('repo6');
    // Pre-create a NON-EMPTY dir where the worktree would go, so `git worktree add` fails.
    const dir = join(WT_ROOT, 't6');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stale.txt'), 'leftover');
    expect(() =>
      prepareWorkspace({
        kind: 'worktree',
        taskId: 't6',
        workspacesRoot: ROOT,
        worktreesRoot: WT_ROOT,
        repoPath: repo
      })
    ).toThrow(/worktree add failed/);
    // The failed attempt cleaned up; a fresh attempt now succeeds.
    const ok = prepareWorkspace({
      kind: 'worktree',
      taskId: 't6',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    expect(existsSync(ok.path)).toBe(true);
    expect(ok.branchName).toBe('kanban/t6');
  });

  it('throws when worktree kind has no repoPath', () => {
    expect(() =>
      prepareWorkspace({
        kind: 'worktree',
        taskId: 't4',
        workspacesRoot: ROOT,
        worktreesRoot: WT_ROOT
      })
    ).toThrow(/repoPath/);
  });

  it('throws when repoPath is not a git repo', () => {
    const notRepo = join(ROOT, 'plain');
    mkdirSync(notRepo);
    expect(() =>
      prepareWorkspace({
        kind: 'worktree',
        taskId: 't5',
        workspacesRoot: ROOT,
        worktreesRoot: WT_ROOT,
        repoPath: notRepo
      })
    ).toThrow();
  });

  it('removeWorktree removes the worktree dir and deletes a merged branch', () => {
    const repo = makeRepo('rm1');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'r1',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    expect(existsSync(path)).toBe(true);
    // Branch is at main's HEAD (no new commits) → merged → safe to delete.
    const { branchKept } = removeWorktree({
      repoPath: repo,
      workspacePath: path,
      branchName,
      baseBranch: 'main'
    });
    expect(branchKept).toBe(false);
    expect(existsSync(path)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'kanban/r1'], {
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('');
  });

  it('removeWorktree force-removes a worktree with uncommitted changes', () => {
    const repo = makeRepo('rm2');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'r2',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    // Uncommitted change is not on the branch tip, so the branch is still merged.
    writeFileSync(join(path, 'dirty.txt'), 'uncommitted');
    removeWorktree({ repoPath: repo, workspacePath: path, branchName, baseBranch: 'main' });
    expect(existsSync(path)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'kanban/r2'], {
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('');
  });

  it('removeWorktree does not throw when the dir was deleted out-of-band, and still drops a merged branch', () => {
    const repo = makeRepo('rm3');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'r3',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    rmSync(path, { recursive: true, force: true }); // simulate manual deletion
    expect(() =>
      removeWorktree({ repoPath: repo, workspacePath: path, branchName, baseBranch: 'main' })
    ).not.toThrow();
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'kanban/r3'], {
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('');
  });

  it('removeWorktree keeps an unmerged branch (preserves the work)', () => {
    const repo = makeRepo('rm4');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'r4',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    // Add a commit on the branch that is NOT in main → unmerged.
    writeFileSync(join(path, 'feature.txt'), 'work');
    execFileSync('git', ['-C', path, 'add', '-A']);
    execFileSync('git', ['-C', path, 'commit', '-q', '-m', 'feature work']);
    const { branchKept } = removeWorktree({
      repoPath: repo,
      workspacePath: path,
      branchName,
      baseBranch: 'main'
    });
    expect(branchKept).toBe(true);
    expect(existsSync(path)).toBe(false); // dir still freed
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'kanban/r4'], {
      encoding: 'utf8'
    });
    expect(branches.trim()).not.toBe(''); // branch preserved
  });

  // Commit `feat.txt` on a freshly-created worktree task branch and return its base.
  function worktreeWithCommit(repo: string, taskId: string): { branch: string; base: string } {
    const { path, branchName, baseBranch } = prepareWorkspace({
      kind: 'worktree',
      taskId,
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    writeFileSync(join(path, 'feat.txt'), 'feature');
    execFileSync('git', ['-C', path, 'add', '-A']);
    execFileSync('git', ['-C', path, 'commit', '-q', '-m', 'feat']);
    return { branch: branchName as string, base: baseBranch as string };
  }

  it('mergeWorktreeToBase merges in place when the base branch is checked out (common case)', () => {
    const repo = makeRepo('mg1');
    const { branch, base } = worktreeWithCommit(repo, 'm1');
    // `main` is checked out at repo — a push would be refused; we merge in place.
    const res = mergeWorktreeToBase({
      repoPath: repo,
      branchName: branch,
      baseBranch: base,
      worktreeParentDir: WT_ROOT,
      taskId: 'm1',
      title: 'feature'
    });
    expect(res.ok).toBe(true);
    // Base advanced: the feature file is now in the repo's checkout.
    expect(existsSync(join(repo, 'feat.txt'))).toBe(true);
  });

  it('mergeWorktreeToBase refuses when the checked-out base has uncommitted changes', () => {
    const repo = makeRepo('mg2');
    const { branch, base } = worktreeWithCommit(repo, 'm2');
    writeFileSync(join(repo, 'dirty.txt'), 'wip'); // dirty the base checkout
    const res = mergeWorktreeToBase({
      repoPath: repo,
      branchName: branch,
      baseBranch: base,
      worktreeParentDir: WT_ROOT,
      taskId: 'm2',
      title: 'feature'
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/uncommitted/);
    expect(existsSync(join(repo, 'feat.txt'))).toBe(false); // base untouched
  });

  it('mergeWorktreeToBase reports a conflict and restores the base checkout', () => {
    const repo = makeRepo('mg3');
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'add shared']);
    const { path, branchName, baseBranch } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'm3',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    // Task branch and main diverge on the same file → merge conflict.
    writeFileSync(join(path, 'shared.txt'), 'feature\n');
    execFileSync('git', ['-C', path, 'add', '-A']);
    execFileSync('git', ['-C', path, 'commit', '-q', '-m', 'feature change']);
    writeFileSync(join(repo, 'shared.txt'), 'mainline\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'main change']);
    const res = mergeWorktreeToBase({
      repoPath: repo,
      branchName: branchName as string,
      baseBranch: baseBranch as string,
      worktreeParentDir: WT_ROOT,
      taskId: 'm3',
      title: 'feature'
    });
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
    // The aborted merge left the base checkout clean.
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status.trim()).toBe('');
  });

  it('mergeWorktreeToBase pushes into base when it is not checked out anywhere', () => {
    const repo = makeRepo('mg4');
    const { branch, base } = worktreeWithCommit(repo, 'm4');
    // Park the repo off main so the base ref is not checked out anywhere.
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'parking']);
    const res = mergeWorktreeToBase({
      repoPath: repo,
      branchName: branch,
      baseBranch: base,
      worktreeParentDir: WT_ROOT,
      taskId: 'm4',
      title: 'feature'
    });
    expect(res.ok).toBe(true);
    const tree = execFileSync('git', ['-C', repo, 'ls-tree', '--name-only', 'main'], {
      encoding: 'utf8'
    });
    expect(tree).toMatch(/feat\.txt/);
  });

  it('removeWorktree keeps the branch when no base is known (conservative)', () => {
    const repo = makeRepo('rm5');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'r5',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    const { branchKept } = removeWorktree({ repoPath: repo, workspacePath: path, branchName });
    expect(branchKept).toBe(true);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'kanban/r5'], {
      encoding: 'utf8'
    });
    expect(branches.trim()).not.toBe('');
  });
});
