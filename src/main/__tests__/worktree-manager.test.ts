import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorktreeManager } from '../starbase/worktree-manager';
import { execSync } from 'child_process';
import { rmSync, mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-worktree');
const REPO_DIR = join(TEST_DIR, 'repo');
const WORKTREE_BASE = join(TEST_DIR, 'worktrees');

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(REPO_DIR, { recursive: true });
  // Initialize a git repo with one commit
  execSync('git init && git checkout -b main', { cwd: REPO_DIR });
  writeFileSync(join(REPO_DIR, 'README.md'), '# Test');
  execSync('git add -A && git commit -m "initial"', { cwd: REPO_DIR });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('WorktreeManager', () => {
  it('should create a worktree', () => {
    const mgr = new WorktreeManager(WORKTREE_BASE);
    const result = mgr.create({
      starbaseId: 'test-sb',
      crewId: 'api-crew-a1b2',
      sectorPath: REPO_DIR,
      baseBranch: 'main',
    });

    expect(result.worktreeBranch).toBe('crew/api-crew-a1b2');
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(existsSync(join(result.worktreePath, 'README.md'))).toBe(true);
  });

  it('should handle branch name collision with numeric suffix', () => {
    const mgr = new WorktreeManager(WORKTREE_BASE);
    // Create first worktree
    mgr.create({
      starbaseId: 'test-sb',
      crewId: 'api-crew-a1b2',
      sectorPath: REPO_DIR,
      baseBranch: 'main',
    });
    // Create second with same crewId — should get suffix
    const result = mgr.create({
      starbaseId: 'test-sb',
      crewId: 'api-crew-a1b2-2',
      sectorPath: REPO_DIR,
      baseBranch: 'main',
    });
    expect(result.worktreeBranch).toBe('crew/api-crew-a1b2-2');
  });

  it('should remove a worktree', () => {
    const mgr = new WorktreeManager(WORKTREE_BASE);
    const result = mgr.create({
      starbaseId: 'test-sb',
      crewId: 'rm-crew',
      sectorPath: REPO_DIR,
      baseBranch: 'main',
    });
    mgr.remove(result.worktreePath, REPO_DIR);
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it('should detect lockfile type for dependency install', () => {
    const mgr = new WorktreeManager(WORKTREE_BASE);
    const result = mgr.create({
      starbaseId: 'test-sb',
      crewId: 'dep-crew',
      sectorPath: REPO_DIR,
      baseBranch: 'main',
    });
    // No lockfile — should return null (skip install)
    const cmd = mgr.detectInstallCommand(result.worktreePath);
    expect(cmd).toBeNull();
  });
});
