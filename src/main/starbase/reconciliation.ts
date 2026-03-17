import type Database from 'better-sqlite3';
import { existsSync, readdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

type ReconciliationDeps = {
  db: Database.Database;
  starbaseId: string;
  worktreeBasePath: string;
};

type ReconciliationSummary = {
  lostCrew: string[];
  orphanedWorktrees: string[];
  retriedPushes: number[];
  requeuedMissions: number[];
};

type CrewRow = {
  id: string;
  sector_id: string;
  pid: number | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  created_at: string;
};

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function runReconciliation(deps: ReconciliationDeps): Promise<ReconciliationSummary> {
  const { db, starbaseId, worktreeBasePath } = deps;
  const summary: ReconciliationSummary = {
    lostCrew: [],
    orphanedWorktrees: [],
    retriedPushes: [],
    requeuedMissions: [],
  };

  // 1. Query all active crew
  const activeCrew = db
    .prepare("SELECT id, sector_id, pid, worktree_path, worktree_branch, created_at FROM crew WHERE status = 'active'")
    .all() as CrewRow[];

  // 2-3. Check PIDs, mark dead ones as lost
  for (const crew of activeCrew) {
    const isAlive = crew.pid ? isPidAlive(crew.pid) : false;
    const createdAt = new Date(crew.created_at.replace(' ', 'T') + 'Z');
    const age = Date.now() - createdAt.getTime();
    const isStale = age > STALE_THRESHOLD_MS;

    if (!isAlive || isStale) {
      db.prepare("UPDATE crew SET status = 'lost', updated_at = datetime('now') WHERE id = ?").run(crew.id);
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'reconciliation', ?)",
      ).run(crew.id, JSON.stringify({ reason: isAlive ? 'stale (PID reuse suspected)' : 'PID dead on restart' }));
      summary.lostCrew.push(crew.id);
    }
  }

  // 4. Preserve worktree branches for dead crew (do NOT clean up)

  // 5. Run git worktree prune on each sector
  const sectors = db.prepare('SELECT id, root_path FROM sectors').all() as { id: string; root_path: string }[];
  for (const sector of sectors) {
    if (existsSync(sector.root_path)) {
      try {
        execSync('git worktree prune', { cwd: sector.root_path, stdio: 'pipe' });
      } catch {
        // Ignore prune failures
      }
    }
  }

  // 6. Sweep worktree directories — remove orphaned ones
  const worktreeDir = join(worktreeBasePath, starbaseId);
  if (existsSync(worktreeDir)) {
    const trackedPaths = new Set(
      (db.prepare("SELECT worktree_path FROM crew WHERE worktree_path IS NOT NULL").all() as { worktree_path: string }[])
        .map((r) => r.worktree_path),
    );

    const entries = readdirSync(worktreeDir);
    for (const entry of entries) {
      const fullPath = join(worktreeDir, entry);
      if (!trackedPaths.has(fullPath)) {
        try {
          rmSync(fullPath, { recursive: true, force: true });
          summary.orphanedWorktrees.push(fullPath);
        } catch {
          console.error(`[reconciliation] Failed to remove orphaned worktree: ${fullPath}`);
        }
      }
    }
  }

  // 7. Retry push-pending missions
  const pushPending = db
    .prepare("SELECT id, crew_id FROM missions WHERE status = 'push-pending'")
    .all() as { id: number; crew_id: string | null }[];

  for (const mission of pushPending) {
    if (!mission.crew_id) continue;
    const crew = db.prepare('SELECT worktree_branch, sector_id FROM crew WHERE id = ?').get(mission.crew_id) as {
      worktree_branch: string | null;
      sector_id: string;
    } | undefined;

    if (!crew?.worktree_branch) continue;

    const sector = sectors.find((s) => s.id === crew.sector_id);
    if (!sector || !existsSync(sector.root_path)) continue;

    try {
      execSync(`git push -u origin "${crew.worktree_branch}"`, { cwd: sector.root_path, stdio: 'pipe' });
      db.prepare("UPDATE missions SET status = 'completed' WHERE id = ?").run(mission.id);
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'push_retried', ?)",
      ).run(mission.crew_id, JSON.stringify({ missionId: mission.id }));
      summary.retriedPushes.push(mission.id);
    } catch {
      // Push still failing — leave as push-pending
    }
  }

  // 8. Reset active missions with lost crew to queued
  const lostCrewIds = summary.lostCrew;
  for (const crewId of lostCrewIds) {
    const missions = db
      .prepare("SELECT id FROM missions WHERE crew_id = ? AND status = 'active'")
      .all(crewId) as { id: number }[];

    for (const mission of missions) {
      db.prepare("UPDATE missions SET status = 'queued', crew_id = NULL, started_at = NULL WHERE id = ?").run(mission.id);
      summary.requeuedMissions.push(mission.id);
    }
  }

  // 9. Return summary
  return summary;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
