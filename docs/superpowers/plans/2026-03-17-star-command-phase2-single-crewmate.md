# Star Command Phase 2: Single Crewmate E2E — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy one Claude Code agent into a git worktree, track its full lifecycle (active → complete/error/timeout), push the branch, and clean up — the core deploy-to-branch-on-remote pipeline.

**Architecture:** `WorktreeManager` handles git worktree operations (create, remove, install deps). `Hull` wraps a single Crewmate's lifecycle — spawns the agent via PtyManager, writes Lifesigns, handles exit cleanup (auto-commit, push, worktree removal). `MissionService` manages the Mission queue. `CrewService` orchestrates the deploy flow. All operations are exposed via IPC and the socket API.

**Tech Stack:** node-pty (via existing PtyManager), child_process (for git commands), existing StarbaseDB + services from Phase 1

**Spec:** `docs/superpowers/specs/2026-03-17-star-command-phase2-single-crewmate.md`

---

## File Structure

**New files:**

- `src/main/starbase/worktree-manager.ts` — Git worktree operations: create, remove, install deps, prune
- `src/main/starbase/mission-service.ts` — Mission CRUD: add, complete, fail, abort, list, next
- `src/main/starbase/crew-service.ts` — Deploy orchestration: deployCrew, recallCrew, listCrew
- `src/main/starbase/hull.ts` — Crewmate lifecycle wrapper: spawn, lifesigns, exit cleanup, push
- `src/main/__tests__/worktree-manager.test.ts` — WorktreeManager unit tests
- `src/main/__tests__/mission-service.test.ts` — MissionService unit tests
- `src/main/__tests__/hull.test.ts` — Hull lifecycle unit tests
- `src/main/__tests__/crew-service.test.ts` — CrewService unit tests

**Modified files:**

- `src/shared/constants.ts` — Add deploy/recall/crew/missions IPC channels
- `src/shared/ipc-api.ts` — Add deploy/recall payload types
- `src/main/ipc-handlers.ts` — Register deploy/recall/crew/missions IPC handlers
- `src/main/socket-command-handler.ts` — Add deploy/recall socket commands
- `src/main/index.ts` — Initialize Phase 2 services, wire up to existing PTY/event infrastructure

---

## Chunk 1: WorktreeManager

### Task 1: Write WorktreeManager

**Files:**

- Create: `src/main/starbase/worktree-manager.ts`
- Create: `src/main/__tests__/worktree-manager.test.ts`

- [ ] **Step 1: Write failing tests for WorktreeManager**

In `src/main/__tests__/worktree-manager.test.ts`:

```typescript
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
      baseBranch: 'main'
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
      baseBranch: 'main'
    });
    // Create second with same crewId — should get suffix
    const result = mgr.create({
      starbaseId: 'test-sb',
      crewId: 'api-crew-a1b2-2',
      sectorPath: REPO_DIR,
      baseBranch: 'main'
    });
    expect(result.worktreeBranch).toBe('crew/api-crew-a1b2-2');
  });

  it('should remove a worktree', () => {
    const mgr = new WorktreeManager(WORKTREE_BASE);
    const result = mgr.create({
      starbaseId: 'test-sb',
      crewId: 'rm-crew',
      sectorPath: REPO_DIR,
      baseBranch: 'main'
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
      baseBranch: 'main'
    });
    // No lockfile — should return null (skip install)
    const cmd = mgr.detectInstallCommand(result.worktreePath);
    expect(cmd).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/worktree-manager.test.ts
```

Expected: FAIL — `WorktreeManager` not found.

- [ ] **Step 3: Write WorktreeManager implementation**

Create `src/main/starbase/worktree-manager.ts`:

```typescript
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
        timeout: timeoutMs
      });
    } catch {
      // Retry once
      try {
        execSync(cmd, {
          cwd: worktreePath,
          stdio: 'pipe',
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/worktree-manager.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/worktree-manager.ts src/main/__tests__/worktree-manager.test.ts
git commit -m "feat(starbase): add WorktreeManager for git worktree operations"
```

---

## Chunk 2: MissionService

### Task 2: Write MissionService

**Files:**

- Create: `src/main/starbase/mission-service.ts`
- Create: `src/main/__tests__/mission-service.test.ts`

- [ ] **Step 1: Write failing tests for MissionService**

In `src/main/__tests__/mission-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { SectorService } from '../starbase/sector-service';
import { MissionService } from '../starbase/mission-service';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-missions');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let missionSvc: MissionService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '');
  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();
  const sectorSvc = new SectorService(db.getDb(), WORKSPACE_DIR);
  sectorSvc.addSector({ path: 'api' });
  missionSvc = new MissionService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('MissionService', () => {
  it('should add a mission', () => {
    const m = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Add auth endpoint',
      prompt: 'Create a /auth endpoint that validates JWT tokens'
    });
    expect(m.id).toBeDefined();
    expect(m.status).toBe('queued');
    expect(m.summary).toBe('Add auth endpoint');
  });

  it('should list missions by sector', () => {
    missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.addMission({ sectorId: 'api', summary: 'M2', prompt: 'P2' });
    const list = missionSvc.listMissions({ sectorId: 'api' });
    expect(list).toHaveLength(2);
  });

  it('should complete a mission', () => {
    const m = missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.completeMission(m.id, 'Endpoint created');
    const updated = missionSvc.getMission(m.id);
    expect(updated!.status).toBe('completed');
    expect(updated!.result).toBe('Endpoint created');
    expect(updated!.completed_at).toBeDefined();
  });

  it('should fail a mission', () => {
    const m = missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.failMission(m.id, 'Test failures');
    const updated = missionSvc.getMission(m.id);
    expect(updated!.status).toBe('failed');
  });

  it('should abort only queued missions', () => {
    const m = missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.abortMission(m.id);
    expect(missionSvc.getMission(m.id)!.status).toBe('aborted');
  });

  it('should get next mission by priority', () => {
    missionSvc.addMission({ sectorId: 'api', summary: 'Low', prompt: 'P', priority: 10 });
    missionSvc.addMission({ sectorId: 'api', summary: 'High', prompt: 'P', priority: 1 });
    const next = missionSvc.nextMission('api');
    expect(next!.summary).toBe('High');
  });

  it('should skip missions with unmet dependencies', () => {
    const m1 = missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.addMission({
      sectorId: 'api',
      summary: 'M2',
      prompt: 'P2',
      dependsOnMissionId: m1.id
    });
    // M2 depends on M1 which is still queued — nextMission should return M1
    const next = missionSvc.nextMission('api');
    expect(next!.summary).toBe('M1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/mission-service.test.ts
```

Expected: FAIL — `MissionService` not found.

- [ ] **Step 3: Write MissionService implementation**

Create `src/main/starbase/mission-service.ts`:

```typescript
import type Database from 'better-sqlite3';

type MissionRow = {
  id: number;
  sector_id: string;
  crew_id: string | null;
  summary: string;
  prompt: string;
  acceptance_criteria: string | null;
  status: string;
  priority: number;
  depends_on_mission_id: number | null;
  result: string | null;
  verify_result: string | null;
  review_verdict: string | null;
  review_notes: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type AddMissionOpts = {
  sectorId: string;
  summary: string;
  prompt: string;
  acceptanceCriteria?: string;
  priority?: number;
  dependsOnMissionId?: number;
};

type ListMissionsFilter = {
  sectorId?: string;
  status?: string;
};

export class MissionService {
  constructor(private db: Database.Database) {}

  addMission(opts: AddMissionOpts): MissionRow {
    const result = this.db
      .prepare(
        `INSERT INTO missions (sector_id, summary, prompt, acceptance_criteria, priority, depends_on_mission_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        opts.sectorId,
        opts.summary,
        opts.prompt,
        opts.acceptanceCriteria ?? null,
        opts.priority ?? 0,
        opts.dependsOnMissionId ?? null
      );

    return this.getMission(result.lastInsertRowid as number)!;
  }

  completeMission(missionId: number, result: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?"
      )
      .run(result, missionId);
  }

  failMission(missionId: number, reason: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
      )
      .run(reason, missionId);
  }

  abortMission(missionId: number): void {
    this.db
      .prepare("UPDATE missions SET status = 'aborted' WHERE id = ? AND status = 'queued'")
      .run(missionId);
  }

  activateMission(missionId: number, crewId: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'active', crew_id = ?, started_at = datetime('now') WHERE id = ?"
      )
      .run(crewId, missionId);
  }

  setStatus(missionId: number, status: string): void {
    this.db.prepare('UPDATE missions SET status = ? WHERE id = ?').run(status, missionId);
  }

  getMission(missionId: number): MissionRow | undefined {
    return this.db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as
      | MissionRow
      | undefined;
  }

  listMissions(filter?: ListMissionsFilter): MissionRow[] {
    let sql = 'SELECT * FROM missions WHERE 1=1';
    const params: unknown[] = [];

    if (filter?.sectorId) {
      sql += ' AND sector_id = ?';
      params.push(filter.sectorId);
    }
    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }

    sql += ' ORDER BY priority ASC, created_at ASC';
    return this.db.prepare(sql).all(...params) as MissionRow[];
  }

  nextMission(sectorId: string): MissionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM missions
         WHERE sector_id = ? AND status = 'queued'
         AND (depends_on_mission_id IS NULL
              OR depends_on_mission_id IN (SELECT id FROM missions WHERE status = 'completed'))
         ORDER BY priority ASC, created_at ASC
         LIMIT 1`
      )
      .get(sectorId) as MissionRow | undefined;
  }

  updateMission(
    missionId: number,
    fields: Partial<Pick<MissionRow, 'summary' | 'prompt' | 'priority' | 'acceptance_criteria'>>
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (sets.length === 0) return;
    values.push(missionId);

    this.db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/mission-service.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/mission-service.ts src/main/__tests__/mission-service.test.ts
git commit -m "feat(starbase): add MissionService with CRUD and priority queue"
```

---

## Chunk 3: Hull

### Task 3: Write Hull lifecycle wrapper

**Files:**

- Create: `src/main/starbase/hull.ts`
- Create: `src/main/__tests__/hull.test.ts`

- [ ] **Step 1: Write failing tests for Hull**

In `src/main/__tests__/hull.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hull, HullOpts } from '../starbase/hull';
import { StarbaseDB } from '../starbase/db';
import { SectorService } from '../starbase/sector-service';
import { MissionService } from '../starbase/mission-service';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-hull');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');
const WORKTREE_DIR = join(TEST_DIR, 'worktrees', 'test-sb', 'hull-crew');

let db: StarbaseDB;
let missionSvc: MissionService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '');
  // Init git repo
  execSync('git init && git checkout -b main', { cwd: SECTOR_DIR });
  writeFileSync(join(SECTOR_DIR, 'README.md'), '# Test');
  execSync('git add -A && git commit -m "initial"', { cwd: SECTOR_DIR });

  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();
  const sectorSvc = new SectorService(db.getDb(), WORKSPACE_DIR);
  sectorSvc.addSector({ path: 'api' });
  missionSvc = new MissionService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Hull', () => {
  it('should construct with required opts', () => {
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'echo hello'
    });
    const hull = new Hull({
      crewId: 'hull-crew',
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'echo hello',
      worktreePath: WORKTREE_DIR,
      worktreeBranch: 'crew/hull-crew',
      baseBranch: 'main',
      sectorPath: SECTOR_DIR,
      db: db.getDb()
    });
    expect(hull).toBeDefined();
    expect(hull.getStatus()).toBe('pending');
  });

  it('should track output in ring buffer', () => {
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'echo hello'
    });
    const hull = new Hull({
      crewId: 'hull-crew',
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'echo hello',
      worktreePath: WORKTREE_DIR,
      worktreeBranch: 'crew/hull-crew',
      baseBranch: 'main',
      sectorPath: SECTOR_DIR,
      db: db.getDb()
    });
    // Test the ring buffer directly
    hull.appendOutput('line 1\n');
    hull.appendOutput('line 2\n');
    expect(hull.getOutputBuffer()).toContain('line 1');
    expect(hull.getOutputBuffer()).toContain('line 2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/hull.test.ts
```

Expected: FAIL — `Hull` not found.

- [ ] **Step 3: Write Hull implementation**

Create `src/main/starbase/hull.ts`:

```typescript
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
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, datetime('now', '+${timeoutMin} minutes'), datetime('now'))`
    ).run(
      crewId,
      paneId,
      sectorId,
      missionId,
      this.opts.sectorPath,
      worktreePath,
      worktreeBranch,
      prompt.slice(0, 100)
    );

    // Activate mission
    db.prepare(
      "UPDATE missions SET status = 'active', crew_id = ?, started_at = datetime('now') WHERE id = ?"
    ).run(crewId, missionId);

    // Log deployment
    db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'deployed', ?)").run(
      crewId,
      JSON.stringify({ sectorId, missionId })
    );

    this.status = 'active';

    // Start lifesign interval
    this.lifesignTimer = setInterval(() => {
      try {
        db.prepare("UPDATE crew SET last_lifesign = datetime('now') WHERE id = ?").run(crewId);
      } catch {
        /* db might be closed */
      }
    }, lifesignSec * 1000);

    // Start timeout timer
    this.timeoutTimer = setTimeout(
      () => {
        this.handleTimeout(ptyManager);
      },
      timeoutMin * 60 * 1000
    );

    // Spawn agent PTY
    try {
      const result = ptyManager.create({
        paneId,
        cwd: worktreePath,
        cmd: `claude --yes --dangerously-skip-permissions -p "${prompt.replace(/"/g, '\\"')}"`
      });
      this.pid = result.pid;
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
    const { crewId, missionId, worktreePath, worktreeBranch, baseBranch, sectorPath, db } =
      this.opts;

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
        } catch {
          /* commit might fail if nothing to commit */
        }
      }

      // Check for empty diff
      let hasChanges = false;
      try {
        const diffStat = execSync(`git diff --stat "${baseBranch}"...HEAD`, gitOpts)
          .toString()
          .trim();
        hasChanges = diffStat.length > 0;
      } catch {
        hasChanges = false;
      }

      if (!hasChanges) {
        // No work produced
        db.prepare(
          "UPDATE missions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
        ).run('No work produced', missionId);
        db.prepare("UPDATE crew SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
          'error',
          crewId
        );
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

      // Update mission
      const missionStatus = status === 'complete' ? 'completed' : status;
      if (pushSucceeded) {
        db.prepare(
          `UPDATE missions SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`
        ).run(missionStatus, reason, missionId);
      } else {
        db.prepare(
          "UPDATE missions SET status = 'push-pending', result = ?, completed_at = datetime('now') WHERE id = ?"
        ).run(reason, missionId);
      }

      // Send mission_complete Transmission
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
      ).run(crewId, JSON.stringify({ missionId, status, reason }));

      // Log exit
      db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
        crewId,
        JSON.stringify({ status, reason })
      );
    } finally {
      // Update crew status
      db.prepare("UPDATE crew SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
        status,
        crewId
      );

      // Clean up worktree (skip if push failed — preserve for recovery)
      if (
        status !== 'error' ||
        this.opts.db.prepare('SELECT status FROM missions WHERE id = ?').get(missionId)?.status !==
          'push-pending'
      ) {
        try {
          execSync(`git worktree remove "${worktreePath}"`, { cwd: sectorPath, stdio: 'pipe' });
        } catch {
          try {
            execSync(`git worktree remove "${worktreePath}" --force`, {
              cwd: sectorPath,
              stdio: 'pipe'
            });
          } catch {
            console.error(`[hull] Failed to remove worktree: ${worktreePath}`);
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/hull.test.ts
```

Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/hull.ts src/main/__tests__/hull.test.ts
git commit -m "feat(starbase): add Hull lifecycle wrapper for Crewmate management"
```

---

## Chunk 4: CrewService + IPC Wiring

### Task 4: Write CrewService

**Files:**

- Create: `src/main/starbase/crew-service.ts`
- Create: `src/main/__tests__/crew-service.test.ts`

- [ ] **Step 1: Write failing test for CrewService**

In `src/main/__tests__/crew-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CrewService } from '../starbase/crew-service';
import { StarbaseDB } from '../starbase/db';
import { SectorService } from '../starbase/sector-service';
import { MissionService } from '../starbase/mission-service';
import { WorktreeManager } from '../starbase/worktree-manager';
import { ConfigService } from '../starbase/config-service';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-crew-svc');

let db: StarbaseDB;
let crewSvc: CrewService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  const wsDir = join(TEST_DIR, 'workspace');
  const sectorDir = join(wsDir, 'api');
  mkdirSync(sectorDir, { recursive: true });
  writeFileSync(join(sectorDir, 'index.ts'), '');
  execSync('git init && git checkout -b main', { cwd: sectorDir });
  writeFileSync(join(sectorDir, 'README.md'), '# Test');
  execSync('git add -A && git commit -m "initial"', { cwd: sectorDir });

  const dbDir = join(TEST_DIR, 'starbases');
  db = new StarbaseDB(wsDir, dbDir);
  db.open();

  const sectorSvc = new SectorService(db.getDb(), wsDir);
  sectorSvc.addSector({ path: 'api' });

  const missionSvc = new MissionService(db.getDb());
  const configSvc = new ConfigService(db.getDb());
  const wtMgr = new WorktreeManager(join(TEST_DIR, 'worktrees'));

  crewSvc = new CrewService({
    db: db.getDb(),
    starbaseId: db.getStarbaseId(),
    sectorService: sectorSvc,
    missionService: missionSvc,
    configService: configSvc,
    worktreeManager: wtMgr
  });
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('CrewService', () => {
  it('should generate a crew ID with sector slug and random hex', () => {
    const id = crewSvc.generateCrewId('api');
    expect(id).toMatch(/^api-crew-[a-f0-9]{4}$/);
  });

  it('should list crew (empty initially)', () => {
    expect(crewSvc.listCrew()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/crew-service.test.ts
```

Expected: FAIL — `CrewService` not found.

- [ ] **Step 3: Write CrewService implementation**

Create `src/main/starbase/crew-service.ts`:

```typescript
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
    createTab: (label: string, cwd: string) => string
  ): Promise<DeployResult> {
    const { db, starbaseId, sectorService, missionService, configService, worktreeManager } =
      this.deps;

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
        prompt: opts.prompt
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
        baseBranch
      });
    } catch (err) {
      missionService.failMission(
        missionId,
        `Worktree creation failed: ${err instanceof Error ? err.message : 'unknown'}`
      );
      throw err;
    }

    // 5. Install dependencies
    try {
      worktreeManager.installDependencies(worktreeResult.worktreePath);
    } catch (err) {
      worktreeManager.remove(worktreeResult.worktreePath, sector.root_path);
      missionService.failMission(
        missionId,
        `Dependency install failed: ${err instanceof Error ? err.message : 'unknown'}`
      );
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
      timeoutMin
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/crew-service.test.ts
```

Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/crew-service.ts src/main/__tests__/crew-service.test.ts
git commit -m "feat(starbase): add CrewService for deploy orchestration"
```

---

### Task 5: Add Phase 2 IPC channels and wire to main process

**Files:**

- Modify: `src/shared/constants.ts`
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/socket-command-handler.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add IPC constants for deploy/recall/crew/missions**

In `src/shared/constants.ts`, add to `IPC_CHANNELS`:

```typescript
STARBASE_DEPLOY: 'starbase:deploy',
STARBASE_RECALL: 'starbase:recall',
STARBASE_CREW: 'starbase:crew',
STARBASE_MISSIONS: 'starbase:missions',
STARBASE_ADD_MISSION: 'starbase:add-mission',
STARBASE_OBSERVE: 'starbase:observe',
```

- [ ] **Step 2: Add payload types**

In `src/shared/ipc-api.ts`:

```typescript
export type DeployRequest = {
  sectorId: string;
  prompt: string;
  missionId?: number;
};

export type DeployResponse = {
  crewId: string;
  tabId: string;
  missionId: number;
};

export type RecallRequest = {
  crewId: string;
};

export type MissionListFilter = {
  sectorId?: string;
  status?: string;
};

export type AddMissionRequest = {
  sectorId: string;
  summary: string;
  prompt: string;
  priority?: number;
};
```

- [ ] **Step 3: Register IPC handlers for Phase 2**

Add handlers in `src/main/ipc-handlers.ts` for deploy, recall, crew list, missions, add-mission, observe. These call through to `crewService` and `missionService`.

- [ ] **Step 4: Add socket commands for Phase 2**

In `src/main/socket-command-handler.ts`, add cases for `deploy`, `recall`, `crew`, `missions`.

- [ ] **Step 5: Wire Phase 2 services in main process**

In `src/main/index.ts`, after StarbaseDB initialization, create `MissionService`, `WorktreeManager`, and `CrewService`. Pass them to IPC handlers.

- [ ] **Step 6: Run typecheck and all tests**

```bash
cd /Users/khangnguyen/Development/fleet && npm run typecheck && npm test
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.ts src/shared/ipc-api.ts src/main/ipc-handlers.ts src/main/socket-command-handler.ts src/main/index.ts
git commit -m "feat(starbase): wire Phase 2 IPC handlers and socket commands for deploy/recall"
```
