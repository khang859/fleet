import type Database from 'better-sqlite3';
import { execSync, ExecSyncOptions } from 'child_process';
import type { PtyManager } from '../pty-manager';

export type HullOpts = {
  crewId: string;
  sectorId: string;
  missionId: number;
  prompt: string;
  worktreePath: string;
  worktreeBranch: string;
  baseBranch: string;
  sectorPath: string;
  db: Database.Database;
  lifesignIntervalSec?: number;
  timeoutMin?: number;
  mergeStrategy?: string;
  onComplete?: () => void;
};

type HullStatus = 'pending' | 'active' | 'complete' | 'error' | 'timeout' | 'aborted';

const MAX_OUTPUT_LINES = 200;

export class Hull {
  private status: HullStatus = 'pending';
  private outputLines: string[] = [];
  private lifesignTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private paneId: string | null = null;
  private pid: number | null = null;

  private static ghAvailable: boolean | null = null;

  constructor(private opts: HullOpts) {}

  /**
   * Start the Hull lifecycle. Requires a PtyManager to spawn the agent.
   * Returns the paneId of the created PTY.
   */
  async start(ptyManager: PtyManager, paneId: string): Promise<void> {
    this.paneId = paneId;
    const { crewId, sectorId, missionId, prompt, worktreePath, worktreeBranch, db } = this.opts;
    const lifesignSec = this.opts.lifesignIntervalSec ?? 10;
    const timeoutMin = this.opts.timeoutMin ?? 15;

    // Insert crew record
    db.prepare(
      `INSERT INTO crew (id, tab_id, sector_id, mission_id, sector_path, worktree_path,
        worktree_branch, status, mission_summary, pid, deadline, last_lifesign)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, datetime('now', '+${timeoutMin} minutes'), datetime('now'))`,
    ).run(
      crewId,
      paneId,
      sectorId,
      missionId,
      this.opts.sectorPath,
      worktreePath,
      worktreeBranch,
      prompt.slice(0, 100),
    );

    // Activate mission
    db.prepare(
      "UPDATE missions SET status = 'active', crew_id = ?, started_at = datetime('now') WHERE id = ?",
    ).run(crewId, missionId);

    // Log deployment
    db.prepare(
      "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'deployed', ?)",
    ).run(crewId, JSON.stringify({ sectorId, missionId }));

    this.status = 'active';

    // Start lifesign interval
    this.lifesignTimer = setInterval(() => {
      try {
        db.prepare("UPDATE crew SET last_lifesign = datetime('now') WHERE id = ?").run(crewId);
      } catch { /* db might be closed */ }
    }, lifesignSec * 1000);

    // Start timeout timer
    this.timeoutTimer = setTimeout(() => {
      this.handleTimeout(ptyManager);
    }, timeoutMin * 60 * 1000);

    // Spawn agent PTY and protect it from the renderer-driven GC
    try {
      const result = ptyManager.create({
        paneId,
        cwd: worktreePath,
        cmd: `claude --yes --dangerously-skip-permissions -p "${prompt.replace(/"/g, '\\"')}"`,
      });
      this.pid = result.pid;
      ptyManager.protect(paneId);
      db.prepare('UPDATE crew SET pid = ? WHERE id = ?').run(result.pid, crewId);
    } catch (err) {
      this.cleanup('error', `Spawn failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return;
    }

    // Listen for output
    ptyManager.onData(paneId, (data) => {
      this.appendOutput(data);
    });

    // Listen for exit
    ptyManager.onExit(paneId, (exitCode) => {
      const status = exitCode === 0 ? 'complete' : 'error';
      this.cleanup(status, exitCode === 0 ? 'Completed successfully' : `Exit code: ${exitCode}`);
    });
  }

  kill(ptyManager: PtyManager): void {
    if (this.paneId && ptyManager.has(this.paneId)) {
      ptyManager.kill(this.paneId);
    }
    this.cleanup('aborted', 'Recalled by Star Command');
  }

  getStatus(): HullStatus {
    return this.status;
  }

  getPid(): number | null {
    return this.pid;
  }

  appendOutput(data: string): void {
    const lines = data.split('\n');
    this.outputLines.push(...lines);
    if (this.outputLines.length > MAX_OUTPUT_LINES) {
      this.outputLines = this.outputLines.slice(-MAX_OUTPUT_LINES);
    }
  }

  getOutputBuffer(): string {
    return this.outputLines.join('\n');
  }

  private handleTimeout(ptyManager: PtyManager): void {
    if (this.paneId && ptyManager.has(this.paneId)) {
      ptyManager.kill(this.paneId);
    }
    // Cleanup will be called by the onExit handler, but if kill doesn't trigger exit:
    setTimeout(() => {
      if (this.status === 'active') {
        this.cleanup('timeout', 'Mission deadline exceeded');
      }
    }, 5000);
  }

  private cleanup(status: HullStatus, reason: string): void {
    if (this.status !== 'active' && this.status !== 'pending') return; // Already cleaned up

    this.status = status;
    const { crewId, missionId, worktreePath, worktreeBranch, baseBranch, sectorPath, db } = this.opts;

    // Stop timers
    if (this.lifesignTimer) clearInterval(this.lifesignTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);

    const gitOpts: ExecSyncOptions = { cwd: worktreePath, stdio: 'pipe' };

    try {
      // Auto-commit uncommitted files
      try {
        execSync('git add -A', gitOpts);
        execSync('git diff --cached --quiet', gitOpts);
      } catch {
        // There are staged changes — commit them
        try {
          execSync('git commit -m "auto-commit uncommitted changes"', gitOpts);
        } catch { /* commit might fail if nothing to commit */ }
      }

      // Check for empty diff
      let hasChanges = false;
      try {
        const diffStat = execSync(`git diff --stat "${baseBranch}"...HEAD`, gitOpts).toString().trim();
        hasChanges = diffStat.length > 0;
      } catch {
        hasChanges = false;
      }

      if (!hasChanges) {
        // No work produced
        db.prepare("UPDATE missions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?")
          .run('No work produced', missionId);
        db.prepare("UPDATE crew SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run('error', crewId);
        return;
      }

      // Phase 5 placeholder: verify_command would run here

      // Push branch
      let pushSucceeded = false;
      const pushRetries = [2000, 8000, 30000];
      for (let i = 0; i <= pushRetries.length; i++) {
        try {
          execSync(`git push -u origin "${worktreeBranch}"`, { cwd: sectorPath, stdio: 'pipe' });
          pushSucceeded = true;
          break;
        } catch {
          if (i < pushRetries.length) {
            execSync(`sleep ${pushRetries[i] / 1000}`, { stdio: 'pipe' });
          }
        }
      }

      // Rebase handling after push
      let hasConflicts = false;
      let conflictFiles: string[] = [];
      if (pushSucceeded) {
        try {
          const movedCount = execSync(
            `git rev-list "${baseBranch}..origin/${baseBranch}" --count`,
            gitOpts,
          ).toString().trim();

          if (parseInt(movedCount, 10) > 0) {
            // Base branch has moved — attempt rebase
            try {
              execSync(`git rebase "origin/${baseBranch}"`, gitOpts);
              // Rebase succeeded — force push with lease
              try {
                execSync(`git push --force-with-lease origin "${worktreeBranch}"`, { cwd: sectorPath, stdio: 'pipe' });
              } catch {
                // Force push failed — acceptable, branch already pushed
              }
            } catch {
              // Rebase failed — abort and note conflicts
              hasConflicts = true;
              try {
                const conflictOutput = execSync('git diff --name-only --diff-filter=U', gitOpts).toString().trim();
                conflictFiles = conflictOutput ? conflictOutput.split('\n') : [];
              } catch { /* ignore */ }
              try {
                execSync('git rebase --abort', gitOpts);
              } catch { /* ignore */ }
            }
          }
        } catch {
          // Could not check base branch — skip rebase
        }
      }

      // PR creation
      const mergeStrategy = this.opts.mergeStrategy ?? 'pr';
      if (pushSucceeded && mergeStrategy !== 'branch-only') {
        this.createPR(hasConflicts, conflictFiles);
      }

      // Update mission
      const missionStatus = status === 'complete' ? 'completed' : status;
      if (pushSucceeded) {
        db.prepare(`UPDATE missions SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`)
          .run(missionStatus, reason, missionId);
      } else {
        db.prepare("UPDATE missions SET status = 'push-pending', result = ?, completed_at = datetime('now') WHERE id = ?")
          .run(reason, missionId);
      }

      // Send mission_complete Transmission
      const commsPayload: Record<string, unknown> = { missionId, status, reason };
      if (hasConflicts) {
        commsPayload.hasConflicts = true;
        commsPayload.conflictFiles = conflictFiles;
      }
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)",
      ).run(crewId, JSON.stringify(commsPayload));

      // Log exit
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)",
      ).run(crewId, JSON.stringify({ status, reason }));

    } finally {
      // Update crew status
      db.prepare("UPDATE crew SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, crewId);

      // Clean up worktree (skip if push failed — preserve for recovery)
      const missionRow = db.prepare("SELECT status FROM missions WHERE id = ?").get(missionId) as { status: string } | undefined;
      if (status !== 'error' || missionRow?.status !== 'push-pending') {
        try {
          execSync(`git worktree remove "${worktreePath}"`, { cwd: sectorPath, stdio: 'pipe' });
        } catch {
          try {
            execSync(`git worktree remove "${worktreePath}" --force`, { cwd: sectorPath, stdio: 'pipe' });
          } catch {
            console.error(`[hull] Failed to remove worktree: ${worktreePath}`);
          }
        }
      }

      // Notify completion for auto-deploy
      if (this.opts.onComplete) {
        try {
          this.opts.onComplete();
        } catch {
          // Don't let callback errors break cleanup
        }
      }
    }
  }

  private createPR(isDraft: boolean, conflictFiles: string[]): void {
    if (!Hull.isGhAvailable()) return;

    const { crewId, sectorId, missionId, prompt, worktreeBranch, baseBranch, sectorPath, db } = this.opts;
    const mergeStrategy = this.opts.mergeStrategy ?? 'pr';

    const summary = prompt.slice(0, 100);
    const draftFlag = isDraft ? '--draft' : '';

    // Get diff stat for PR body
    let diffStat = '';
    try {
      diffStat = execSync(`git diff --stat "${baseBranch}"...HEAD`, {
        cwd: sectorPath,
        stdio: 'pipe',
      }).toString().trim();
    } catch { /* ignore */ }

    const conflictNote = isDraft && conflictFiles.length > 0
      ? `\n\n### Merge Conflicts\nRebase failed on: ${conflictFiles.join(', ')}`
      : '';

    const body = `## Mission: ${summary}\n\n**Sector:** ${sectorId}\n**Crewmate:** ${crewId}\n\n### Changes\n\`\`\`\n${diffStat}\n\`\`\`${conflictNote}\n\n---\nDeployed by Star Command`;

    try {
      const labelArgs = `--label fleet --label "sector/${sectorId}" --label "mission/${missionId}"`;
      execSync(
        `gh pr create --title "${summary.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --base "${baseBranch}" --head "${worktreeBranch}" ${draftFlag} ${labelArgs}`,
        { cwd: sectorPath, stdio: 'pipe' },
      );

      // Auto-merge if configured
      if (mergeStrategy === 'auto-merge' && !isDraft) {
        try {
          execSync(`gh pr merge --auto --squash "${worktreeBranch}"`, { cwd: sectorPath, stdio: 'pipe' });
        } catch {
          // Auto-merge might fail due to conflicts — warn Admiral
          db.prepare(
            "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'auto_merge_failed', ?)",
          ).run(crewId, JSON.stringify({ missionId, worktreeBranch }));
        }
      }
    } catch (err) {
      // PR creation failed — fall back to branch-only, invalidate gh cache
      Hull.ghAvailable = null;
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'pr_creation_failed', ?)",
      ).run(crewId, JSON.stringify({ missionId, error: err instanceof Error ? err.message : 'unknown' }));
    }
  }

  private static isGhAvailable(): boolean {
    if (Hull.ghAvailable !== null) return Hull.ghAvailable;
    try {
      execSync('gh auth status', { stdio: 'pipe' });
      Hull.ghAvailable = true;
    } catch {
      Hull.ghAvailable = false;
    }
    return Hull.ghAvailable;
  }
}
