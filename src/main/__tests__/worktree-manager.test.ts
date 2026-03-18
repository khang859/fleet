import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorktreeManager, WorktreeLimitError } from '../starbase/worktree-manager';
import { StarbaseDB } from '../starbase/db';
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
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: REPO_DIR });
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

describe('WorktreeManager with concurrency limits', () => {
  let starbaseDb: StarbaseDB;

  beforeEach(() => {
    const dbDir = join(TEST_DIR, 'starbases');
    starbaseDb = new StarbaseDB(REPO_DIR, dbDir);
    starbaseDb.open();

    // Insert a sector
    starbaseDb.getDb().prepare('INSERT INTO sectors (id, name, root_path) VALUES (?, ?, ?)').run('api', 'api', REPO_DIR);
  });

  afterEach(() => {
    starbaseDb.close();
  });

  it('should throw WorktreeLimitError when at max concurrent', () => {
    const mgr = new WorktreeManager(WORKTREE_BASE);
    mgr.configure(starbaseDb.getDb(), 1);

    // Insert an active crew with worktree to simulate 1 active
    starbaseDb.getDb()
      .prepare("INSERT INTO crew (id, sector_id, status, worktree_path) VALUES ('existing', 'api', 'active', '/some/path')")
      .run();

    expect(() =>
      mgr.create({
        starbaseId: 'test-sb',
        crewId: 'new-crew',
        sectorPath: REPO_DIR,
        baseBranch: 'main',
      }),
    ).toThrow(WorktreeLimitError);
  });

  it('should allow creation when below limit', () => {
    const mgr = new WorktreeManager(WORKTREE_BASE);
    mgr.configure(starbaseDb.getDb(), 5);

    const result = mgr.create({
      starbaseId: 'test-sb',
      crewId: 'allowed-crew',
      sectorPath: REPO_DIR,
      baseBranch: 'main',
    });
    expect(existsSync(result.worktreePath)).toBe(true);
  });

  it('should mark a worktree as pooled and retrieve it', () => {
    const mgr = new WorktreeManager(WORKTREE_BASE);
    mgr.configure(starbaseDb.getDb(), 5);

    // Create crew with worktree
    const result = mgr.create({
      starbaseId: 'test-sb',
      crewId: 'pool-crew',
      sectorPath: REPO_DIR,
      baseBranch: 'main',
    });

    // Insert crew record with worktree path
    starbaseDb.getDb()
      .prepare("INSERT INTO crew (id, sector_id, status, worktree_path) VALUES ('pool-crew', 'api', 'complete', ?)")
      .run(result.worktreePath);

    // Mark as pooled
    mgr.markPooled('pool-crew');

    // Should be retrievable
    const pooled = mgr.getPooled('test-sb');
    expect(pooled).toBe(result.worktreePath);
  });

  it('should evict stale pooled worktrees', () => {
    const mgr = new WorktreeManager(WORKTREE_BASE);
    mgr.configure(starbaseDb.getDb(), 5);

    const result = mgr.create({
      starbaseId: 'test-sb',
      crewId: 'evict-crew',
      sectorPath: REPO_DIR,
      baseBranch: 'main',
    });

    // Insert crew as pooled with old timestamp
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    starbaseDb.getDb()
      .prepare("INSERT INTO crew (id, sector_id, status, worktree_path, pool_status, pooled_at) VALUES ('evict-crew', 'api', 'complete', ?, 'pooled', ?)")
      .run(result.worktreePath, oldTime);

    const evicted = mgr.evictStale(REPO_DIR);
    expect(evicted).toHaveLength(1);
    expect(existsSync(result.worktreePath)).toBe(false);
  });
});
