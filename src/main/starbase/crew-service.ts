import type Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import type { SectorService } from './sector-service';
import type { MissionService } from './mission-service';
import type { ConfigService } from './config-service';
import type { WorktreeManager } from './worktree-manager';
import { Hull } from './hull';
import type { PtyManager } from '../pty-manager';

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
};

type DeployResult = {
  crewId: string;
  tabId: string;
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
   * Deploy a Crewmate. Returns { crewId, tabId, missionId }.
   * Caller must provide a PtyManager and a way to create tabs.
   */
  async deployCrew(
    opts: { sectorId: string; prompt: string; missionId?: number },
    ptyManager: PtyManager,
    createTab: (label: string, cwd: string) => string,
  ): Promise<DeployResult> {
    const { db, starbaseId, sectorService, missionService, configService, worktreeManager } = this.deps;

    // 1. Look up sector
    const sector = sectorService.getSector(opts.sectorId);
    if (!sector) throw new Error(`Sector not found: ${opts.sectorId}`);

    const baseBranch = sector.base_branch || 'main';

    // 2. Create mission if not provided
    let missionId = opts.missionId;
    if (!missionId) {
      const mission = missionService.addMission({
        sectorId: opts.sectorId,
        summary: opts.prompt.slice(0, 100),
        prompt: opts.prompt,
      });
      missionId = mission.id;
    }

    // 3. Generate crew ID
    const crewId = this.generateCrewId(sector.id);

    // 4. Create worktree
    let worktreeResult;
    try {
      worktreeResult = worktreeManager.create({
        starbaseId,
        crewId,
        sectorPath: sector.root_path,
        baseBranch,
      });
    } catch (err) {
      missionService.failMission(missionId, `Worktree creation failed: ${err instanceof Error ? err.message : 'unknown'}`);
      throw err;
    }

    // 5. Install dependencies
    try {
      worktreeManager.installDependencies(worktreeResult.worktreePath);
    } catch (err) {
      worktreeManager.remove(worktreeResult.worktreePath, sector.root_path);
      missionService.failMission(missionId, `Dependency install failed: ${err instanceof Error ? err.message : 'unknown'}`);
      throw err;
    }

    // 6. Pick avatar variant
    const avatar = AVATAR_VARIANTS[Math.floor(Math.random() * AVATAR_VARIANTS.length)];

    // 7. Create tab
    const tabLabel = opts.prompt.slice(0, 50);
    const tabId = createTab(tabLabel, worktreeResult.worktreePath);

    // 8. Create Hull
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
    });

    // Update crew record with avatar
    db.prepare('UPDATE crew SET avatar_variant = ? WHERE id = ?').run(avatar, crewId);

    this.hulls.set(crewId, hull);

    // 9. Start the Hull
    await hull.start(ptyManager, tabId);

    return { crewId, tabId, missionId };
  }

  recallCrew(crewId: string, ptyManager: PtyManager): void {
    const hull = this.hulls.get(crewId);
    if (hull) {
      hull.kill(ptyManager);
      this.hulls.delete(crewId);
    }
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
}
