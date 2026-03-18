import type Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { getAvailableMemoryBytes } from './available-memory';
import type { SectorService } from './sector-service';
import type { MissionService } from './mission-service';
import type { ConfigService } from './config-service';
import { WorktreeLimitError, type WorktreeManager } from './worktree-manager';
import { Hull } from './hull';
import type { EventBus } from '../event-bus';

export class InsufficientMemoryError extends Error {
  constructor(freeGb: number, requiredGb: number) {
    super(`Insufficient memory to deploy crew: ${freeGb.toFixed(2)}GB free, ${requiredGb}GB required`);
    this.name = 'InsufficientMemoryError';
  }
}

type CrewRow = {
  id: string;
  tab_id: string | null;
  sector_id: string;
  mission_id: number | null;
  sector_path: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  status: string;
  mission_summary: string | null;
  avatar_variant: string | null;
  pid: number | null;
  deadline: string | null;
  token_budget: number;
  tokens_used: number;
  last_lifesign: string | null;
  created_at: string;
  updated_at: string;
};

type CrewServiceDeps = {
  db: Database.Database;
  starbaseId: string;
  sectorService: SectorService;
  missionService: MissionService;
  configService: ConfigService;
  worktreeManager: WorktreeManager;
  eventBus?: EventBus;
  /** Enriched env for crew processes (PATH with claude binary). */
  crewEnv?: Record<string, string>;
};

type DeployResult = {
  crewId: string;
  missionId: number;
};

const AVATAR_VARIANTS = ['hoodie', 'headphones', 'robot', 'cap', 'glasses'];

export class CrewService {
  private hulls = new Map<string, Hull>();

  constructor(private deps: CrewServiceDeps) {}

  generateCrewId(sectorSlug: string): string {
    const hex = randomBytes(2).toString('hex');
    return `${sectorSlug}-crew-${hex}`;
  }

  /**
   * Deploy a Crewmate. Returns { crewId, missionId }.
   * Crews are headless (no terminal tab) — they use stream-json for communication.
   */
  async deployCrew(
    opts: { sectorId: string; prompt: string; missionId?: number },
  ): Promise<DeployResult> {
    const { db, starbaseId, sectorService, missionService, configService, worktreeManager } = this.deps;

    // 1. Look up sector
    const sector = sectorService.getSector(opts.sectorId);
    if (!sector) throw new Error(`Sector not found: ${opts.sectorId}`);

    const baseBranch = sector.base_branch || 'main';

    // 2. Create mission if not provided (before memory gate so we can queue it on failure)
    let missionId = opts.missionId;
    if (!missionId) {
      const mission = missionService.addMission({
        sectorId: opts.sectorId,
        summary: opts.prompt.slice(0, 100),
        prompt: opts.prompt,
      });
      missionId = mission.id;
    }

    // 3. Memory gate — queue the mission instead of deploying if free RAM is insufficient
    const minFreeGb = configService.get('min_deploy_free_memory_gb') as number;
    const availableGb = (await getAvailableMemoryBytes()) / (1024 * 1024 * 1024);
    if (availableGb < minFreeGb) {
      db.prepare("UPDATE missions SET status = 'queued' WHERE id = ?").run(missionId);
      throw new InsufficientMemoryError(availableGb, minFreeGb);
    }

    // 4. Generate crew ID
    const crewId = this.generateCrewId(sector.id);

    // 5. Create worktree
    let worktreeResult;
    try {
      worktreeResult = worktreeManager.create({
        starbaseId,
        crewId,
        sectorPath: sector.root_path,
        baseBranch,
      });
    } catch (err) {
      if (err instanceof WorktreeLimitError) {
        // Queue the mission instead of deploying
        db.prepare("UPDATE missions SET status = 'queued' WHERE id = ?").run(missionId);
        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('queued', ?)",
        ).run(JSON.stringify({ missionId, reason: 'worktree limit reached' }));
        throw err;
      }
      missionService.failMission(missionId, `Worktree creation failed: ${err instanceof Error ? err.message : 'unknown'}`);
      throw err;
    }

    // 6. Install dependencies
    try {
      worktreeManager.installDependencies(worktreeResult.worktreePath);
    } catch (err) {
      worktreeManager.remove(worktreeResult.worktreePath, sector.root_path);
      missionService.failMission(missionId, `Dependency install failed: ${err instanceof Error ? err.message : 'unknown'}`);
      throw err;
    }

    // 7. Pick avatar variant (stored in DB for UI display even without a tab)
    const avatar = AVATAR_VARIANTS[Math.floor(Math.random() * AVATAR_VARIANTS.length)];

    // 8. Create Hull (headless — no tab, no PtyManager)
    const timeoutMin = configService.get('default_mission_timeout_min') as number;
    const lifesignSec = configService.get('lifesign_interval_sec') as number;

    const hull = new Hull({
      crewId,
      sectorId: opts.sectorId,
      missionId,
      prompt: opts.prompt,
      worktreePath: worktreeResult.worktreePath,
      worktreeBranch: worktreeResult.worktreeBranch,
      baseBranch,
      sectorPath: sector.root_path,
      db,
      lifesignIntervalSec: lifesignSec,
      timeoutMin,
      mergeStrategy: sector.merge_strategy,
      verifyCommand: sector.verify_command ?? undefined,
      lintCommand: sector.lint_command ?? undefined,
      reviewMode: sector.review_mode,
      model: sector.model ?? undefined,
      systemPrompt: sector.system_prompt ?? undefined,
      allowedTools: sector.allowed_tools ?? undefined,
      mcpConfig: sector.mcp_config ?? undefined,
      onComplete: () => this.autoDeployNext(),
      env: this.deps.crewEnv,
    });

    // Update crew record with avatar
    db.prepare('UPDATE crew SET avatar_variant = ? WHERE id = ?').run(avatar, crewId);

    this.hulls.set(crewId, hull);

    // 9. Start the Hull (headless — no paneId)
    await hull.start();

    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    return { crewId, missionId };
  }

  recallCrew(crewId: string): void {
    const hull = this.hulls.get(crewId);
    if (hull) {
      hull.kill();
      this.hulls.delete(crewId);
      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
      return;
    }

    // Hull not in memory (post-restart recall): update DB record directly.
    const TERMINAL_STATUSES = ['error', 'complete', 'timeout', 'lost', 'aborted', 'dismissed'];
    const row = this.deps.db.prepare('SELECT status FROM crew WHERE id = ?').get(crewId) as
      | { status: string }
      | undefined;
    if (!row) return;

    if (TERMINAL_STATUSES.includes(row.status)) {
      this.deps.db
        .prepare("UPDATE crew SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?")
        .run(crewId);
    } else {
      // Active crew with no hull is an inconsistent state — mark as lost
      this.deps.db
        .prepare("UPDATE crew SET status = 'lost', updated_at = datetime('now') WHERE id = ?")
        .run(crewId);
    }
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  /**
   * Send a follow-up message to an active crew's Claude Code process.
   * Returns true if the message was sent, false if the crew is not active.
   */
  messageCrew(crewId: string, message: string): boolean {
    const hull = this.hulls.get(crewId);
    if (!hull || hull.getStatus() !== 'active') return false;
    return hull.sendMessage(message);
  }

  listCrew(filter?: { sectorId?: string }): CrewRow[] {
    let sql = "SELECT * FROM crew WHERE status IN ('active', 'complete', 'error', 'timeout')";
    const params: unknown[] = [];

    if (filter?.sectorId) {
      sql += ' AND sector_id = ?';
      params.push(filter.sectorId);
    }

    sql += ' ORDER BY created_at DESC';
    return this.deps.db.prepare(sql).all(...params) as CrewRow[];
  }

  getCrewStatus(crewId: string): CrewRow | undefined {
    return this.deps.db.prepare('SELECT * FROM crew WHERE id = ?').get(crewId) as
      | CrewRow
      | undefined;
  }

  observeCrew(crewId: string): string {
    const hull = this.hulls.get(crewId);
    return hull?.getOutputBuffer() ?? '';
  }

  /** Get the next queued mission across all sectors (global FIFO by priority) */
  nextQueuedMission(): { id: number; sector_id: string; prompt: string; summary: string } | undefined {
    return this.deps.db
      .prepare(
        `SELECT id, sector_id, prompt, summary FROM missions
         WHERE status = 'queued'
         AND (depends_on_mission_id IS NULL
              OR depends_on_mission_id IN (SELECT id FROM missions WHERE status = 'completed'))
         ORDER BY priority ASC, created_at ASC
         LIMIT 1`,
      )
      .get() as { id: number; sector_id: string; prompt: string; summary: string } | undefined;
  }

  /** Immediately kill all active Hull processes (app shutdown). */
  shutdown(): void {
    for (const [crewId, hull] of this.hulls) {
      try {
        hull.forceKill();
      } catch {
        // Best-effort during shutdown
      }
      this.hulls.delete(crewId);
    }
  }

  /** Auto-deploy next queued mission if worktree slots are available */
  private autoDeployNext(): void {
    const next = this.nextQueuedMission();
    if (!next) return;

    this.deployCrew(
      { sectorId: next.sector_id, prompt: next.prompt, missionId: next.id },
    ).then((result) => {
      // Notify Admiral of auto-deployment
      this.deps.db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'auto_deployed', ?)",
      ).run(result.crewId, JSON.stringify({ missionId: next.id, sectorId: next.sector_id }));
    }).catch(() => {
      // Auto-deploy failed — leave mission queued for next slot
    });
  }
}
