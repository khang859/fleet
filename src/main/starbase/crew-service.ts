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

  generateCrewId(sectorSlug: string, missionType: string = 'code'): string {
    const hex = randomBytes(2).toString('hex');
    return `${sectorSlug}-${missionType}-${hex}`;
  }

  /**
   * Deploy a Crewmate. Returns { crewId, missionId }.
   * Crews are headless (no terminal tab) — they use stream-json for communication.
   */
  async deployCrew(
    opts: { sectorId: string; prompt: string; missionId: number; type?: string; prBranch?: string },
  ): Promise<DeployResult> {
    const { db, starbaseId, sectorService, missionService, configService, worktreeManager } = this.deps;

    // 1. Look up sector
    const sector = sectorService.getSector(opts.sectorId);
    if (!sector) throw new Error(`Sector not found: ${opts.sectorId}`);

    const baseBranch = sector.base_branch || 'main';

    // 2. Validate mission exists with a non-empty prompt
    const missionId = opts.missionId;
    if (!missionId) {
      throw new Error('deployCrew requires a missionId. Create a mission first.');
    }
    if (!opts.prompt || opts.prompt.trim().length === 0) {
      throw new Error(`Mission ${missionId} has an empty prompt. Cannot deploy crew without instructions.`);
    }

    // Read mission type for Hull
    const missionRow = missionService.getMission(missionId)!
    const missionType = missionRow.type ?? 'code'

    // Guard: reject if the mission already has an active crew assigned
    if (missionRow.crew_id !== null) {
      throw new Error(`Mission ${missionId} already has crew ${missionRow.crew_id} assigned. Cannot deploy duplicate.`);
    }

    // 3. Memory gate — queue the mission instead of deploying if free RAM is insufficient
    const minFreeGb = configService.get('min_deploy_free_memory_gb') as number;
    const availableGb = (await getAvailableMemoryBytes()) / (1024 * 1024 * 1024);
    if (availableGb < minFreeGb) {
      db.prepare("UPDATE missions SET status = 'queued' WHERE id = ?").run(missionId);
      throw new InsufficientMemoryError(availableGb, minFreeGb);
    }

    // 4. Generate crew ID
    const crewId = this.generateCrewId(sector.id, missionType);

    // 5. Create worktree
    let worktreeResult;
    try {
      if (opts.prBranch) {
        // Review/fix crew: check out existing PR branch
        worktreeResult = await worktreeManager.createForExistingBranch({
          starbaseId,
          crewId,
          sectorPath: sector.root_path,
          baseBranch,
          existingBranch: opts.prBranch,
        });
      } else {
        worktreeResult = await worktreeManager.create({
          starbaseId,
          crewId,
          sectorPath: sector.root_path,
          baseBranch,
        });
      }
    } catch (err) {
      if (err instanceof WorktreeLimitError) {
        db.prepare("UPDATE missions SET status = 'queued' WHERE id = ?").run(missionId);
        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('queued', ?)",
        ).run(JSON.stringify({ missionId, reason: 'worktree limit reached' }));
        throw err;
      }
      missionService.failMission(missionId, `Worktree creation failed: ${err instanceof Error ? err.message : 'unknown'}`);
      throw err;
    }

    // 6. Install dependencies (skip for review crews — they only read code)
    if (missionType !== 'review') {
      try {
        await worktreeManager.installDependencies(worktreeResult.worktreePath);
      } catch (err) {
        worktreeManager.remove(worktreeResult.worktreePath, sector.root_path);
        missionService.failMission(missionId, `Dependency install failed: ${err instanceof Error ? err.message : 'unknown'}`);
        throw err;
      }
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
      // Research crews default to read-only tools unless sector explicitly overrides
      allowedTools: sector.allowed_tools ?? (missionType === 'research' ? 'Read,Glob,Grep,WebSearch,WebFetch' : undefined),
      mcpConfig: sector.mcp_config ?? undefined,
      onComplete: () => this.autoDeployNext(),
      env: this.deps.crewEnv,
      missionType,
      starbaseId,
      prBranch: opts.prBranch,
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
         AND (
           NOT EXISTS (
             SELECT 1 FROM mission_dependencies WHERE mission_id = missions.id
           )
           OR NOT EXISTS (
             SELECT 1 FROM mission_dependencies md
             JOIN missions dep ON dep.id = md.depends_on_mission_id
             WHERE md.mission_id = missions.id
               AND dep.status NOT IN ('completed', 'failed', 'aborted')
           )
         )
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
    const { db } = this.deps;

    // Atomically claim the next queued mission — prevents concurrent deployments from racing
    const claim = db.prepare(
      `UPDATE missions SET status = 'deploying'
       WHERE id = (
         SELECT id FROM missions
         WHERE status = 'queued'
         AND (
           NOT EXISTS (
             SELECT 1 FROM mission_dependencies WHERE mission_id = missions.id
           )
           OR NOT EXISTS (
             SELECT 1 FROM mission_dependencies md
             JOIN missions dep ON dep.id = md.depends_on_mission_id
             WHERE md.mission_id = missions.id
               AND dep.status NOT IN ('completed', 'failed', 'aborted')
           )
         )
         ORDER BY priority ASC, created_at ASC
         LIMIT 1
       )
       RETURNING id, sector_id, prompt, summary`,
    ).get() as { id: number; sector_id: string; prompt: string; summary: string } | undefined;

    if (!claim) return;

    this.deployCrew(
      { sectorId: claim.sector_id, prompt: claim.prompt, missionId: claim.id },
    ).then((result) => {
      // Notify Admiral of auto-deployment
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'auto_deployed', ?)",
      ).run(result.crewId, JSON.stringify({ missionId: claim.id, sectorId: claim.sector_id }));
    }).catch(() => {
      // Auto-deploy failed — revert to queued so it can be retried next slot
      db.prepare("UPDATE missions SET status = 'queued' WHERE id = ? AND status = 'deploying'").run(claim.id);
    });
  }
}
