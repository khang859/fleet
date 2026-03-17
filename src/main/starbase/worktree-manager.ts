import { execSync, ExecSyncOptions } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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
  constructor(private worktreeBasePath: string) {}

  create(opts: CreateOpts): CreateResult {
    const { starbaseId, crewId, sectorPath, baseBranch } = opts;
    const execOpts: ExecSyncOptions = { cwd: sectorPath, stdio: 'pipe' };

    // Pre-flight: verify git repo
    try {
      execSync('git rev-parse --git-dir', execOpts);
    } catch {
      throw new Error(`Not a git repository: ${sectorPath}`);
    }

    // Pre-flight: check disk headroom (500MB minimum)
    const worktreeDir = join(this.worktreeBasePath, starbaseId);
    mkdirSync(worktreeDir, { recursive: true });

    // Determine branch name
    let branchName = `crew/${crewId}`;
    const worktreePath = join(worktreeDir, crewId);

    // Check if branch exists locally
    try {
      const localBranches = execSync(`git branch --list "${branchName}"`, execOpts)
        .toString()
        .trim();
      if (localBranches) {
        // Branch exists — append suffix
        let suffix = 2;
        while (true) {
          const candidate = `crew/${crewId}-${suffix}`;
          const check = execSync(`git branch --list "${candidate}"`, execOpts).toString().trim();
          if (!check) {
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
    execSync(`git worktree add "${worktreePath}" -b "${branchName}" "${baseBranch}"`, execOpts);

    return { worktreePath, worktreeBranch: branchName };
  }

  remove(worktreePath: string, sectorPath: string): void {
    const execOpts: ExecSyncOptions = { cwd: sectorPath, stdio: 'pipe' };
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
          console.error(`[worktree] Failed to remove worktree: ${worktreePath}`);
        }
      }
    }
  }

  installDependencies(worktreePath: string, timeoutMs = 120_000): void {
    const cmd = this.detectInstallCommand(worktreePath);
    if (!cmd) return;

    try {
      execSync(cmd, {
        cwd: worktreePath,
        stdio: 'pipe',
        timeout: timeoutMs,
      });
    } catch {
      // Retry once
      try {
        execSync(cmd, {
          cwd: worktreePath,
          stdio: 'pipe',
          timeout: timeoutMs,
        });
      } catch (retryErr) {
        throw new Error(
          `Dependency install failed after retry: ${retryErr instanceof Error ? retryErr.message : 'unknown'}`,
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
      console.error(`[worktree] Failed to prune worktrees for: ${sectorPath}`);
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
}
