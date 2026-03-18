import type Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { freemem } from 'os';
import type { ConfigService } from './config-service';

type SentinelDeps = {
  db: Database.Database;
  configService: ConfigService;
};

type CrewRow = {
  id: string;
  sector_id: string;
  status: string;
  last_lifesign: string | null;
  deadline: string | null;
  pid: number | null;
};

type SectorRow = {
  id: string;
  root_path: string;
};

export class Sentinel {
  private interval: ReturnType<typeof setInterval> | null = null;
  private sweepCount = 0;
  private diskCacheBytes: number | null = null;
  private diskCacheTime = 0;

  constructor(private deps: SentinelDeps) {}

  start(intervalMs?: number): void {
    const ms = intervalMs ?? (this.deps.configService.get('lifesign_interval_sec') as number) * 1000;
    this.interval = setInterval(() => {
      this.runSweep().catch((err) => {
        console.error('[sentinel] Sweep failed:', err);
      });
    }, ms);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runSweep(): Promise<void> {
    this.sweepCount++;
    const { db, configService } = this.deps;

    const lifesignTimeout = configService.get('lifesign_timeout_sec') as number;

    // 1. Lifesign check
    const staleCrew = db
      .prepare(
        `SELECT id, sector_id FROM crew
         WHERE status = 'active' AND last_lifesign < datetime('now', '-${lifesignTimeout} seconds')`,
      )
      .all() as CrewRow[];

    for (const crew of staleCrew) {
      db.prepare("UPDATE crew SET status = 'lost', updated_at = datetime('now') WHERE id = ?").run(
        crew.id,
      );
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'lifesign_lost', ?)",
      ).run(crew.id, JSON.stringify({ sectorId: crew.sector_id }));
      // Send transmission to Admiral
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'lifesign_lost', ?)",
      ).run(crew.id, JSON.stringify({ crewId: crew.id, sectorId: crew.sector_id }));
    }

    // 2. Mission deadline check
    const expiredCrew = db
      .prepare(
        `SELECT id, sector_id, pid FROM crew
         WHERE status = 'active' AND deadline IS NOT NULL AND deadline < datetime('now')`,
      )
      .all() as CrewRow[];

    for (const crew of expiredCrew) {
      // Try to kill the process
      if (crew.pid) {
        try {
          process.kill(crew.pid, 'SIGTERM');
        } catch {
          // Process already dead
        }
      }
      db.prepare("UPDATE crew SET status = 'timeout', updated_at = datetime('now') WHERE id = ?").run(
        crew.id,
      );
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'timeout', ?)",
      ).run(crew.id, JSON.stringify({ reason: 'deadline expired' }));
    }

    // 3. Sector path validation
    const sectors = db.prepare('SELECT id, root_path FROM sectors').all() as SectorRow[];
    for (const sector of sectors) {
      if (!existsSync(sector.root_path)) {
        // Mark all crew in this sector as lost
        db.prepare(
          "UPDATE crew SET status = 'lost', updated_at = datetime('now') WHERE sector_id = ? AND status = 'active'",
        ).run(sector.id);
        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('sector_path_missing', ?)",
        ).run(JSON.stringify({ sectorId: sector.id, path: sector.root_path }));
        db.prepare(
          "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'sector_path_missing', ?)",
        ).run(JSON.stringify({ sectorId: sector.id, path: sector.root_path }));
      }
    }

    // 4. Dependency deadlock detection (skip — Phase 5)

    // 5. Disk usage check
    const diskBudgetGb = configService.get('worktree_disk_budget_gb') as number;
    const diskBytes = this.getDiskUsage();
    if (diskBytes !== null) {
      const usedGb = diskBytes / (1024 * 1024 * 1024);
      const pct = (usedGb / diskBudgetGb) * 100;
      if (pct >= 90) {
        db.prepare(
          "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'disk_warning', ?)",
        ).run(JSON.stringify({ usedGb: usedGb.toFixed(2), budgetGb: diskBudgetGb, percent: pct.toFixed(0) }));
      }
    }

    // 6. System memory check
    const freeBytes = freemem();
    const freeGb = freeBytes / (1024 * 1024 * 1024);
    if (freeGb < 1) {
      db.prepare(
        "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'memory_warning', ?)",
      ).run(JSON.stringify({ freeGb: freeGb.toFixed(2), level: freeGb < 0.5 ? 'critical' : 'warning' }));
    }

    // 7. Comms rate limit reset (every 6th sweep = ~60 seconds)
    if (this.sweepCount % 6 === 0) {
      db.prepare('UPDATE crew SET comms_count_minute = 0').run();
    }
  }

  private getDiskUsage(): number | null {
    const now = Date.now();
    if (this.diskCacheBytes !== null && now - this.diskCacheTime < 60_000) {
      return this.diskCacheBytes;
    }

    try {
      // Use home dir worktrees path
      const homePath = process.env.HOME ?? '~';
      const worktreePath = `${homePath}/.fleet/worktrees`;
      if (!existsSync(worktreePath)) return 0;

      const output = execSync(`du -sk "${worktreePath}"`, { stdio: 'pipe' }).toString().trim();
      const kb = parseInt(output.split('\t')[0], 10);
      this.diskCacheBytes = kb * 1024;
      this.diskCacheTime = now;
      return this.diskCacheBytes;
    } catch {
      return null;
    }
  }
}
