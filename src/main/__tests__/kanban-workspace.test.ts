import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { prepareWorkspace, cleanupWorkspace } from '../kanban/workspace';

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
});
