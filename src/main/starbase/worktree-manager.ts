import type Database from 'better-sqlite3';
import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger';

const log = createLogger('worktree');

const execAsync = promisify(exec);

export class WorktreeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeLimitError';
  }
}

type CreateOpts = {
  starbaseId: string;
  crewId: string;
  sectorPath: string;
  baseBranch: string;
};

type CreateResult = {
  worktreePath: string;
  worktreeBranch: string;
};

export class WorktreeManager {
  private db: Database.Database | null = null;
  private maxConcurrent = Infinity;

  constructor(private worktreeBasePath: string) {}

  /** Set DB and concurrency limit for pool and limit features */
  configure(db: Database.Database, maxConcurrent: number): void {
    this.db = db;
    this.maxConcurrent = maxConcurrent;
  }

  async create(opts: CreateOpts): Promise<CreateResult> {
    const { starbaseId, crewId, sectorPath, baseBranch } = opts;
    const execOpts = { cwd: sectorPath };

    // Check concurrency limit
    if (this.db && this.maxConcurrent < Infinity) {
      const row = this.db
        .prepare<
          [],
          { cnt: number }
        >("SELECT COUNT(*) as cnt FROM crew WHERE status = 'active' AND worktree_path IS NOT NULL")
        .get();
      const activeCount = row?.cnt ?? 0;
      if (activeCount >= this.maxConcurrent) {
        throw new WorktreeLimitError(
          `Worktree limit reached: ${activeCount}/${this.maxConcurrent} active`
        );
      }
    }

    // Check pool for reusable worktree
    if (this.db) {
      const pooled = this.getPooled(starbaseId);
      if (pooled) {
        try {
          const recycled = await this.recycle(pooled, baseBranch, crewId);
          if (recycled) return recycled;
        } catch {
          // Recycle failed — fall through to create new
        }
      }
    }

    // Pre-flight: verify git repo
    try {
      await execAsync('git rev-parse --git-dir', execOpts);
    } catch {
      throw new Error(`Not a git repository: ${sectorPath}`);
    }

    const worktreeDir = join(this.worktreeBasePath, starbaseId);
    mkdirSync(worktreeDir, { recursive: true });

    // Determine branch name
    let branchName = `crew/${crewId}`;
    const worktreePath = join(worktreeDir, crewId);

    // Check if branch exists locally
    try {
      const { stdout: localBranches } = await execAsync(
        `git branch --list "${branchName}"`,
        execOpts
      );
      if (localBranches.trim()) {
        // Branch exists — append suffix
        let suffix = 2;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
          const candidate = `crew/${crewId}-${suffix}`;
          const { stdout: check } = await execAsync(`git branch --list "${candidate}"`, execOpts);
          if (!check.trim()) {
            branchName = candidate;
            break;
          }
          suffix++;
        }
      }
    } catch {
      // git branch --list failed, proceed with original name
    }

    // Create worktree
    await execAsync(
      `git worktree add "${worktreePath}" -b "${branchName}" "${baseBranch}"`,
      execOpts
    );

    return { worktreePath, worktreeBranch: branchName };
  }

  async createForExistingBranch(
    opts: CreateOpts & { existingBranch: string }
  ): Promise<CreateResult> {
    const { starbaseId, crewId, sectorPath, existingBranch } = opts;
    const execOpts = { cwd: sectorPath };

    // Check concurrency limit (same as create())
    if (this.db && this.maxConcurrent < Infinity) {
      const row = this.db
        .prepare<
          [],
          { cnt: number }
        >("SELECT COUNT(*) as cnt FROM crew WHERE status = 'active' AND worktree_path IS NOT NULL")
        .get();
      const activeCount = row?.cnt ?? 0;
      if (activeCount >= this.maxConcurrent) {
        throw new WorktreeLimitError(
          `Worktree limit reached: ${activeCount}/${this.maxConcurrent} active`
        );
      }
    }

    // Pre-flight: verify git repo
    try {
      await execAsync('git rev-parse --git-dir', execOpts);
    } catch {
      throw new Error(`Not a git repository: ${sectorPath}`);
    }

    // Fetch the branch from origin to ensure it exists locally as a proper tracking branch
    try {
      await execAsync(`git fetch origin "${existingBranch}":"${existingBranch}"`, execOpts);
    } catch {
      // Branch may already exist locally — try to update it
      try {
        await execAsync(`git fetch origin "${existingBranch}"`, execOpts);
      } catch {
        throw new Error(`Failed to fetch branch: ${existingBranch}`);
      }
    }

    const worktreeDir = join(this.worktreeBasePath, starbaseId);
    mkdirSync(worktreeDir, { recursive: true });
    const worktreePath = join(worktreeDir, crewId);

    // Prune stale worktree metadata before checkout.
    // Prevents "fatal: already checked out at /old/path" when a previous
    // crew's worktree removal failed silently and left a stale .git/worktrees/ entry.
    try {
      await execAsync('git worktree prune', execOpts);
    } catch {
      // non-fatal — proceed regardless
    }

    // Create worktree from existing branch (no -b flag)
    await execAsync(`git worktree add "${worktreePath}" "${existingBranch}"`, execOpts);

    return { worktreePath, worktreeBranch: existingBranch };
  }

  remove(worktreePath: string, sectorPath: string): void {
    const execOpts = { cwd: sectorPath, stdio: 'pipe' as const };
    try {
      execSync(`git worktree remove "${worktreePath}"`, execOpts);
    } catch {
      // Retry after 2 seconds
      try {
        execSync('sleep 2', { stdio: 'pipe' });
        execSync(`git worktree remove "${worktreePath}" --force`, execOpts);
      } catch {
        // Force remove the directory as last resort
        try {
          execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe' });
          execSync('git worktree prune', execOpts);
        } catch {
          log.error(`Failed to remove worktree: ${worktreePath}`);
        }
      }
    }
  }

  async installDependencies(worktreePath: string, timeoutMs = 120_000): Promise<void> {
    const cmd = this.detectInstallCommand(worktreePath);
    if (!cmd) return;

    try {
      await execAsync(cmd, {
        cwd: worktreePath,
        timeout: timeoutMs
      });
    } catch {
      // Retry once
      try {
        await execAsync(cmd, {
          cwd: worktreePath,
          timeout: timeoutMs
        });
      } catch (retryErr) {
        throw new Error(
          `Dependency install failed after retry: ${retryErr instanceof Error ? retryErr.message : 'unknown'}`
        );
      }
    }
  }

  detectInstallCommand(worktreePath: string): string | null {
    if (existsSync(join(worktreePath, 'pnpm-lock.yaml'))) return 'pnpm install';
    if (existsSync(join(worktreePath, 'bun.lockb'))) return 'bun install';
    if (existsSync(join(worktreePath, 'yarn.lock'))) return 'yarn install';
    if (existsSync(join(worktreePath, 'package-lock.json'))) return 'npm install';
    return null;
  }

  prune(sectorPath: string): void {
    try {
      execSync('git worktree prune', { cwd: sectorPath, stdio: 'pipe' });
    } catch {
      log.error(`Failed to prune worktrees for: ${sectorPath}`);
    }
  }

  listActive(starbaseId: string): string[] {
    const dir = join(this.worktreeBasePath, starbaseId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory();
    });
  }

  /** Mark a worktree as pooled for reuse instead of removing it */
  markPooled(crewId: string): void {
    if (!this.db) return;
    this.db
      .prepare("UPDATE crew SET pool_status = 'pooled', pooled_at = datetime('now') WHERE id = ?")
      .run(crewId);
  }

  /** Get a pooled worktree path for the given starbase */
  getPooled(_starbaseId: string): string | null {
    void _starbaseId;
    if (!this.db) return null;
    const row = this.db
      .prepare<
        [],
        { worktree_path: string }
      >("SELECT worktree_path FROM crew WHERE pool_status = 'pooled' AND worktree_path IS NOT NULL ORDER BY pooled_at ASC LIMIT 1")
      .get();
    return row?.worktree_path ?? null;
  }

  /** Recycle a pooled worktree: reset to base branch and create new branch */
  async recycle(
    worktreePath: string,
    baseBranch: string,
    newCrewId: string
  ): Promise<CreateResult | null> {
    if (!existsSync(worktreePath)) return null;
    const execOpts = { cwd: worktreePath };

    try {
      await execAsync(`git checkout "${baseBranch}"`, execOpts);
      await execAsync('git pull', execOpts);
      await execAsync('git clean -fd', execOpts);
      const branchName = `crew/${newCrewId}`;
      await execAsync(`git checkout -b "${branchName}"`, execOpts);

      // Clear pool status for the old crew entry
      if (this.db) {
        this.db
          .prepare('UPDATE crew SET pool_status = NULL WHERE worktree_path = ?')
          .run(worktreePath);
      }

      return { worktreePath, worktreeBranch: branchName };
    } catch {
      return null;
    }
  }

  /** Remove pooled worktrees older than maxAgeMs (default 1 hour) */
  evictStale(sectorPath: string, maxAgeMs: number = 60 * 60 * 1000): string[] {
    if (!this.db) return [];
    const cutoff = new Date(Date.now() - maxAgeMs)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    const stale = this.db
      .prepare<
        [string],
        { id: string; worktree_path: string }
      >("SELECT id, worktree_path FROM crew WHERE pool_status = 'pooled' AND pooled_at < ?")
      .all(cutoff);

    const evicted: string[] = [];
    for (const entry of stale) {
      if (entry.worktree_path) {
        this.remove(entry.worktree_path, sectorPath);
        evicted.push(entry.worktree_path);
      }
      this.db
        .prepare('UPDATE crew SET pool_status = NULL, worktree_path = NULL WHERE id = ?')
        .run(entry.id);
    }
    return evicted;
  }
}
