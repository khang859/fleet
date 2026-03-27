# Research-Backed Code Missions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow code missions to optionally depend on one or more research missions, blocking deployment until research completes, and injecting a lightweight cargo file header into the code crew's initial prompt.

**Architecture:** Replace the single `depends_on_mission_id` FK with a `mission_dependencies` junction table. Update all four dependency-check sites (MissionService, CrewService ×2, SocketServer). Add `buildCargoHeader()` to Hull that queries the junction table and prepends readable cargo paths to the code crew's init message. Surface the feature via a new `--depends-on` CLI flag with a soft nudge for code missions created without it.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Electron main process (Node.js)

**Spec:** `docs/superpowers/specs/2026-03-20-research-backed-code-missions-design.md`

---

## File Map

| File                                         | What changes                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/main/starbase/migrations.ts`            | Add migration version 9: create junction table + backfill                                                           |
| `src/main/starbase/mission-service.ts`       | Update `AddMissionOpts`, `addMission()`, `nextMission()`; add `getDependencies()`, `getDependents()`                |
| `src/main/starbase/crew-service.ts`          | Update `nextQueuedMission()` and `autoDeployNext()` SQL to use junction table                                       |
| `src/main/starbase/hull.ts`                  | Add `buildCargoHeader()` function; inject into init message `content` field                                         |
| `src/main/socket-server.ts`                  | Parse `--depends-on` array, validate IDs, pass to `addMission`, add nudge, update `mission.deploy` dependency guard |
| `src/main/fleet-cli.ts`                      | Extend `parseArgs` to accumulate repeated flags; add `--depends-on` validation                                      |
| `src/main/starbase/workspace-templates.ts`   | Update `generateClaudeMd()` and `generateSkillMd()`                                                                 |
| `src/main/__tests__/mission-service.test.ts` | New tests for dependencies, `nextMission()` with terminal states, migration backfill                                |
| `src/main/__tests__/hull.test.ts`            | New tests for `buildCargoHeader()` variants                                                                         |
| `src/main/__tests__/fleet-cli.test.ts`       | New tests for `parseArgs` multi-value accumulation                                                                  |
| `src/main/__tests__/socket-server.test.ts`   | New tests for `--depends-on` flag in `mission.create` and updated deploy guard                                      |

---

## Task 1: DB Migration — `mission_dependencies` table

**Files:**

- Modify: `src/main/starbase/migrations.ts`

- [ ] **Step 1: Add migration version 9**

  Open `src/main/starbase/migrations.ts`. The last migration is version 8 (`008-pr-review`). Append a new entry after it:

  ```typescript
  {
    version: 9,
    name: '009-mission-dependencies',
    sql: `
      CREATE TABLE IF NOT EXISTS mission_dependencies (
        mission_id             INTEGER NOT NULL REFERENCES missions(id),
        depends_on_mission_id  INTEGER NOT NULL REFERENCES missions(id),
        PRIMARY KEY (mission_id, depends_on_mission_id)
      );

      INSERT OR IGNORE INTO mission_dependencies (mission_id, depends_on_mission_id)
      SELECT id, depends_on_mission_id FROM missions WHERE depends_on_mission_id IS NOT NULL;
    `
  }
  ```

  Both the `CREATE TABLE` and the `INSERT OR IGNORE` backfill are in the **same migration entry** — they run atomically in one transaction. Do not split them.

- [ ] **Step 2: Verify migration runs without error**

  ```bash
  cd /Users/khangnguyen/Development/fleet
  npx vitest run src/main/__tests__/mission-service.test.ts
  ```

  Expected: all existing mission tests pass. Each test opens a fresh StarbaseDB which runs all migrations, including the new one.

- [ ] **Step 3: Commit**

  ```bash
  git add src/main/starbase/migrations.ts
  git commit -m "feat(db): add mission_dependencies junction table (migration 9)"
  ```

---

## Task 2: `MissionService` — dependencies API

**Files:**

- Modify: `src/main/starbase/mission-service.ts`
- Modify: `src/main/__tests__/mission-service.test.ts`

- [ ] **Step 1: Write failing tests**

  Add to `src/main/__tests__/mission-service.test.ts` after the existing `describe` block:

  ```typescript
  describe('MissionService — dependencies', () => {
    it('getDependencies returns [] when no dependencies', () => {
      const m = missionSvc.addMission({
        sectorId: 'api',
        summary: 'Code',
        prompt: 'P',
        type: 'code'
      });
      expect(missionSvc.getDependencies(m.id)).toEqual([]);
    });

    it('getDependents returns [] when no dependents', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'Research',
        prompt: 'P',
        type: 'research'
      });
      expect(missionSvc.getDependents(r.id)).toEqual([]);
    });

    it('addMission with dependsOnMissionIds links via junction table', () => {
      const r1 = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R1',
        prompt: 'P',
        type: 'research'
      });
      const r2 = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R2',
        prompt: 'P',
        type: 'research'
      });
      const code = missionSvc.addMission({
        sectorId: 'api',
        summary: 'Code',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r1.id, r2.id]
      });
      const deps = missionSvc.getDependencies(code.id);
      expect(deps).toHaveLength(2);
      expect(deps.map((d) => d.id)).toContain(r1.id);
      expect(deps.map((d) => d.id)).toContain(r2.id);
    });

    it('getDependents returns code missions that depend on a research mission', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R',
        prompt: 'P',
        type: 'research'
      });
      const c1 = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C1',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      const c2 = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C2',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      const dependents = missionSvc.getDependents(r.id);
      expect(dependents).toHaveLength(2);
      expect(dependents.map((d) => d.id)).toContain(c1.id);
      expect(dependents.map((d) => d.id)).toContain(c2.id);
    });
  });

  describe('MissionService — nextMission with junction table', () => {
    it('queues code mission until research dependency completes', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R',
        prompt: 'P',
        type: 'research'
      });
      missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      // Research not complete — code mission should not be next
      expect(missionSvc.nextMission('api')).toBeUndefined();
    });

    it('unblocks code mission when research dependency completes', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R',
        prompt: 'P',
        type: 'research'
      });
      const code = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      missionSvc.completeMission(r.id, 'done');
      expect(missionSvc.nextMission('api')?.id).toBe(code.id);
    });

    it('unblocks code mission when research dependency fails (terminal state)', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R',
        prompt: 'P',
        type: 'research'
      });
      const code = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      missionSvc.failMission(r.id, 'error');
      expect(missionSvc.nextMission('api')?.id).toBe(code.id);
    });

    it('unblocks code mission when research dependency is aborted', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R',
        prompt: 'P',
        type: 'research'
      });
      const code = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      missionSvc.abortMission(r.id);
      expect(missionSvc.nextMission('api')?.id).toBe(code.id);
    });

    it('stays blocked when one of two dependencies is still queued', () => {
      const r1 = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R1',
        prompt: 'P',
        type: 'research'
      });
      const r2 = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R2',
        prompt: 'P',
        type: 'research'
      });
      missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r1.id, r2.id]
      });
      missionSvc.completeMission(r1.id, 'done');
      // r2 still queued — code mission blocked
      expect(missionSvc.nextMission('api')).toBeUndefined();
    });

    it('mission with no dependencies is immediately eligible', () => {
      const m = missionSvc.addMission({
        sectorId: 'api',
        summary: 'Simple',
        prompt: 'P',
        type: 'code'
      });
      expect(missionSvc.nextMission('api')?.id).toBe(m.id);
    });
  });
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  npx vitest run src/main/__tests__/mission-service.test.ts
  ```

  Expected: new test cases FAIL (methods don't exist yet, `nextMission` uses old query).

- [ ] **Step 3: Update `AddMissionOpts` type**

  In `src/main/starbase/mission-service.ts`, replace the `AddMissionOpts` type:

  ```typescript
  type AddMissionOpts = {
    sectorId: string;
    summary: string;
    prompt: string;
    acceptanceCriteria?: string;
    priority?: number;
    dependsOnMissionIds?: number[];
    type?: string;
    prBranch?: string;
  };
  ```

- [ ] **Step 4: Update `addMission()` to insert junction rows**

  After the existing `this.getMission(result.lastInsertRowid as number)!` call and before the `eventBus?.emit` line, add:

  ```typescript
  for (const depId of opts.dependsOnMissionIds ?? []) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO mission_dependencies (mission_id, depends_on_mission_id) VALUES (?, ?)'
      )
      .run(result.lastInsertRowid, depId);
  }
  ```

- [ ] **Step 5: Update `nextMission()` to use junction table**

  Replace the entire `nextMission` method body:

  ```typescript
  nextMission(sectorId: string): MissionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM missions
         WHERE sector_id = ? AND status = 'queued'
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
         LIMIT 1`
      )
      .get(sectorId) as MissionRow | undefined
  }
  ```

- [ ] **Step 6: Add `getDependencies()` and `getDependents()` methods**

  Add after `nextMission`:

  ```typescript
  getDependencies(missionId: number): MissionRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM missions m
         JOIN mission_dependencies md ON md.depends_on_mission_id = m.id
         WHERE md.mission_id = ?`
      )
      .all(missionId) as MissionRow[]
  }

  getDependents(missionId: number): MissionRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM missions m
         JOIN mission_dependencies md ON md.mission_id = m.id
         WHERE md.depends_on_mission_id = ?`
      )
      .all(missionId) as MissionRow[]
  }
  ```

- [ ] **Step 7: Run tests — all should pass**

  ```bash
  npx vitest run src/main/__tests__/mission-service.test.ts
  ```

  Expected: all tests PASS.

- [ ] **Step 8: Commit**

  ```bash
  git add src/main/starbase/mission-service.ts src/main/__tests__/mission-service.test.ts
  git commit -m "feat(missions): many-to-many dependencies via junction table"
  ```

---

## Task 3: Update stale dependency guards in `crew-service.ts`

**Files:**

- Modify: `src/main/starbase/crew-service.ts`

The two SQL queries in `crew-service.ts` still use the old `depends_on_mission_id IS NULL OR depends_on_mission_id IN (...)` guard. Both must be updated to mirror the junction table logic.

- [ ] **Step 1: Update `nextQueuedMission()` at line 265**

  Replace the SQL string inside `nextQueuedMission()`:

  ```typescript
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
      .get() as { id: number; sector_id: string; prompt: string; summary: string } | undefined
  }
  ```

- [ ] **Step 2: Update `autoDeployNext()` at line 295**

  Replace the `UPDATE missions SET status = 'deploying' WHERE id = (SELECT ...)` SQL inside `autoDeployNext()`:

  ```typescript
  const claim = db
    .prepare(
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
     RETURNING id, sector_id, prompt, summary`
    )
    .get() as { id: number; sector_id: string; prompt: string; summary: string } | undefined;
  ```

- [ ] **Step 3: Add smoke tests for crew-service dependency unblocking**

  In `src/main/__tests__/crew-service.test.ts`, find the existing test setup and add:

  ```typescript
  it('nextQueuedMission does not return code mission blocked by queued research', () => {
    const r = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R',
      prompt: 'P',
      type: 'research'
    });
    missionSvc.addMission({
      sectorId: 'api',
      summary: 'C',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r.id]
    });
    expect(crewService.nextQueuedMission()).toBeUndefined();
  });

  it('nextQueuedMission returns code mission when research dependency is completed', () => {
    const r = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R',
      prompt: 'P',
      type: 'research'
    });
    const code = missionSvc.addMission({
      sectorId: 'api',
      summary: 'C',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r.id]
    });
    missionSvc.completeMission(r.id, 'done');
    expect(crewService.nextQueuedMission()?.id).toBe(code.id);
  });

  it('nextQueuedMission returns code mission when research dependency failed', () => {
    const r = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R',
      prompt: 'P',
      type: 'research'
    });
    const code = missionSvc.addMission({
      sectorId: 'api',
      summary: 'C',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r.id]
    });
    missionSvc.failMission(r.id, 'error');
    expect(crewService.nextQueuedMission()?.id).toBe(code.id);
  });
  ```

- [ ] **Step 4: Run all mission and crew tests**

  ```bash
  npx vitest run src/main/__tests__/mission-service.test.ts src/main/__tests__/crew-service.test.ts
  ```

  Expected: all PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/starbase/crew-service.ts src/main/__tests__/crew-service.test.ts
  git commit -m "fix(crew): update dependency guards to use mission_dependencies junction table"
  ```

---

## Task 4: Update `socket-server.ts` — `mission.create` and `mission.deploy`

**Files:**

- Modify: `src/main/socket-server.ts`
- Modify: `src/main/__tests__/socket-server.test.ts`

- [ ] **Step 1: Write failing tests**

  Open `src/main/__tests__/socket-server.test.ts`. Study the existing test setup carefully — it initialises a real `SocketServer` with a real SQLite DB and a `sendCommand` helper. Follow its exact setup pattern, then add a new describe block:

  ```typescript
  describe('mission.create — --depends-on flag', () => {
    it('links a single research dependency', async () => {
      const r = await sendCommand(server, {
        type: 'mission.create',
        args: { sector: 'api', type: 'research', summary: 'R', prompt: 'investigate' }
      });
      const code = await sendCommand(server, {
        type: 'mission.create',
        args: {
          sector: 'api',
          type: 'code',
          summary: 'C',
          prompt: 'implement',
          'depends-on': String(r.data.id)
        }
      });
      expect(code.data.dependencies).toEqual([r.data.id]);
    });

    it('links multiple research dependencies', async () => {
      const r1 = await sendCommand(server, {
        type: 'mission.create',
        args: { sector: 'api', type: 'research', summary: 'R1', prompt: 'investigate' }
      });
      const r2 = await sendCommand(server, {
        type: 'mission.create',
        args: { sector: 'api', type: 'research', summary: 'R2', prompt: 'investigate' }
      });
      const code = await sendCommand(server, {
        type: 'mission.create',
        args: {
          sector: 'api',
          type: 'code',
          summary: 'C',
          prompt: 'implement',
          'depends-on': [String(r1.data.id), String(r2.data.id)]
        }
      });
      expect(code.data.dependencies).toHaveLength(2);
    });

    it('returns BAD_REQUEST for non-existent dependency ID', async () => {
      const result = await sendCommand(server, {
        type: 'mission.create',
        args: { sector: 'api', type: 'code', summary: 'C', prompt: 'P', 'depends-on': '9999' }
      });
      expect(result.ok).toBe(false);
    });

    it('appends nudge text for code mission without --depends-on', async () => {
      const result = await sendCommand(server, {
        type: 'mission.create',
        args: { sector: 'api', type: 'code', summary: 'C', prompt: 'P' }
      });
      expect(result.ok).toBe(true);
      expect(result.nudge).toContain('research mission');
    });

    it('does not append nudge for code mission with --depends-on', async () => {
      const r = await sendCommand(server, {
        type: 'mission.create',
        args: { sector: 'api', type: 'research', summary: 'R', prompt: 'P' }
      });
      const result = await sendCommand(server, {
        type: 'mission.create',
        args: {
          sector: 'api',
          type: 'code',
          summary: 'C',
          prompt: 'P',
          'depends-on': String(r.data.id)
        }
      });
      expect(result.nudge).toBeUndefined();
    });
  });

  describe('mission.deploy — junction table dependency guard', () => {
    it('blocks deploy when research dependency is still queued', async () => {
      const r = await sendCommand(server, {
        type: 'mission.create',
        args: { sector: 'api', type: 'research', summary: 'R', prompt: 'P' }
      });
      const code = await sendCommand(server, {
        type: 'mission.create',
        args: {
          sector: 'api',
          type: 'code',
          summary: 'C',
          prompt: 'P',
          'depends-on': String(r.data.id)
        }
      });
      const deploy = await sendCommand(server, {
        type: 'crew.deploy',
        args: { sector: 'api', mission: String(code.data.id) }
      });
      expect(deploy.ok).toBe(false);
      expect(deploy.error).toContain('depends on');
    });

    it('allows deploy when research dependency is completed', async () => {
      // (This test only verifies the guard passes — actual crew deploy will fail without git setup,
      // so catch any error from the deploy itself but confirm no "depends on" guard error)
      const r = await sendCommand(server, {
        type: 'mission.create',
        args: { sector: 'api', type: 'research', summary: 'R', prompt: 'P' }
      });
      // Mark research completed directly via DB
      db.prepare("UPDATE missions SET status = 'completed' WHERE id = ?").run(r.data.id);
      const code = await sendCommand(server, {
        type: 'mission.create',
        args: {
          sector: 'api',
          type: 'code',
          summary: 'C',
          prompt: 'P',
          'depends-on': String(r.data.id)
        }
      });
      const deploy = await sendCommand(server, {
        type: 'crew.deploy',
        args: { sector: 'api', mission: String(code.data.id) }
      });
      // Either succeeds or fails for non-dependency reasons — but NOT "depends on" error
      if (!deploy.ok) {
        expect(deploy.error).not.toContain('depends on');
      }
    });
  });
  ```

- [ ] **Step 2: Run to confirm they fail**

  ```bash
  npx vitest run src/main/__tests__/socket-server.test.ts
  ```

  Expected: new tests FAIL.

- [ ] **Step 3: Update `mission.create` handler in `socket-server.ts` (around line 295)**

  After the existing `type`, `prompt`, `summary` parsing and before `missionService.addMission(...)`, add dependency parsing and validation:

  ```typescript
  // Parse --depends-on (may be a single string or array of strings)
  const rawDeps = args['depends-on'];
  const dependsOnMissionIds: number[] =
    rawDeps == null
      ? []
      : (Array.isArray(rawDeps) ? rawDeps : [rawDeps])
          .map(Number)
          .filter((n) => !isNaN(n) && n > 0);

  // Validate each dependency ID exists
  for (const depId of dependsOnMissionIds) {
    const dep = missionService.getMission(depId);
    if (!dep) {
      const err = new Error(`Cannot link dependency: mission ${depId} does not exist.`) as Error & {
        code: string;
      };
      err.code = 'BAD_REQUEST';
      throw err;
    }
  }
  ```

  Then update the `missionService.addMission(...)` call to pass `dependsOnMissionIds`. The old `dependsOnMissionId` field has been removed from `AddMissionOpts` in Task 2 — do NOT include it:

  ```typescript
  const mission = missionService.addMission({
    sectorId,
    summary,
    prompt,
    dependsOnMissionIds,
    type,
    prBranch
  });
  ```

  **Note:** The return shape now always includes `dependencies: number[]`. Any existing `mission.create` tests that do strict equality on the returned object will need updating to expect this new field.

  Then update the return value to include `dependencies` and an optional `nudge`:

  ```typescript
  const nudge =
    type === 'code' && dependsOnMissionIds.length === 0
      ? 'Tip: Consider attaching a research mission to provide context before this code mission runs. Use --depends-on <research-mission-id> to link one. Skip this for trivial changes.'
      : undefined;

  this.emit('state-change', 'mission:changed', { mission });
  return nudge
    ? { ...mission, dependencies: dependsOnMissionIds, nudge }
    : { ...mission, dependencies: dependsOnMissionIds };
  ```

- [ ] **Step 4: Update `mission.deploy` dependency guard in `socket-server.ts` (around line 476)**

  Replace the old `if (mission.depends_on_mission_id)` block with a junction table check:

  ```typescript
  // Check all dependencies via junction table
  const blockedDeps = missionService
    .getDependencies(missionId)
    .filter((dep) => !['completed', 'failed', 'aborted'].includes(dep.status));
  if (blockedDeps.length > 0) {
    const depList = blockedDeps.map((d) => `#${d.id} (${d.status})`).join(', ');
    throw new Error(
      `Cannot deploy: mission ${missionId} depends on mission(s) ${depList} which have not reached a terminal state.`
    );
  }
  ```

- [ ] **Step 5: Run tests — all should pass**

  ```bash
  npx vitest run src/main/__tests__/socket-server.test.ts
  ```

  Expected: all PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/socket-server.ts src/main/__tests__/socket-server.test.ts
  git commit -m "feat(socket): add --depends-on flag to mission.create, update deploy dependency guard"
  ```

---

## Task 5: Update `fleet-cli.ts` — `parseArgs` multi-value + validation

**Files:**

- Modify: `src/main/fleet-cli.ts`
- Modify: `src/main/__tests__/fleet-cli.test.ts`

- [ ] **Step 1: Write failing tests for `parseArgs`**

  In `src/main/__tests__/fleet-cli.test.ts`, find or add a `describe('parseArgs', ...)` block and add:

  ```typescript
  it('accumulates repeated --depends-on flags into an array', () => {
    const result = parseArgs(['--depends-on', '12', '--depends-on', '15']);
    expect(result['depends-on']).toEqual(['12', '15']);
  });

  it('keeps single --depends-on as a plain string (not array)', () => {
    const result = parseArgs(['--depends-on', '12']);
    expect(result['depends-on']).toBe('12');
  });
  ```

  And add a validation test. `validateCommand` is a private function in `fleet-cli.ts` — it is not currently exported. Before writing this test, **export it**:

  In `src/main/fleet-cli.ts`, change:

  ```typescript
  function validateCommand(
  ```

  to:

  ```typescript
  export function validateCommand(
  ```

  Then write the test:

  ```typescript
  import { parseArgs, validateCommand } from '../fleet-cli';

  it('validateCommand errors on non-numeric --depends-on', () => {
    const error = validateCommand('mission.create', {
      sector: 'api',
      type: 'code',
      summary: 'S',
      prompt: 'P',
      'depends-on': 'not-a-number'
    });
    expect(error).toContain('--depends-on');
  });
  ```

- [ ] **Step 2: Run to confirm they fail**

  ```bash
  npx vitest run src/main/__tests__/fleet-cli.test.ts
  ```

  Expected: new tests FAIL.

- [ ] **Step 3: Update `parseArgs` to accumulate `--depends-on`**

  In `src/main/fleet-cli.ts`, update the `parseArgs` function. Replace:

  ```typescript
  if (next !== undefined && !next.startsWith('--')) {
    result[key] = next;
    i += 2;
  } else {
    result[key] = true;
    i += 1;
  }
  ```

  With:

  ```typescript
  if (next !== undefined && !next.startsWith('--')) {
    if (key === 'depends-on') {
      // Accumulate into array for repeated flags
      const existing = result[key];
      result[key] =
        existing === undefined
          ? next
          : Array.isArray(existing)
            ? [...existing, next]
            : [existing as string, next];
    } else {
      result[key] = next;
    }
    i += 2;
  } else {
    result[key] = true;
    i += 1;
  }
  ```

- [ ] **Step 4: Add `--depends-on` validation to `validateCommand` `mission.create` case**

  In `src/main/fleet-cli.ts`, inside the `case 'mission.create':` block (around line 322), add after the existing type validation:

  ```typescript
  if (args['depends-on'] !== undefined) {
    const depIds = Array.isArray(args['depends-on'])
      ? (args['depends-on'] as string[])
      : [args['depends-on'] as string];
    for (const depId of depIds) {
      const n = Number(depId);
      if (isNaN(n) || n <= 0) {
        return `Error: --depends-on must be a numeric mission ID, got: "${depId}".\n\nUsage: fleet missions add ... --depends-on <research-mission-id>`;
      }
    }
  }
  ```

- [ ] **Step 5: Run tests — all should pass**

  ```bash
  npx vitest run src/main/__tests__/fleet-cli.test.ts
  ```

  Expected: all PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/fleet-cli.ts src/main/__tests__/fleet-cli.test.ts
  git commit -m "feat(cli): extend parseArgs to accumulate --depends-on, add mission.create validation"
  ```

---

## Task 6: Hull — cargo header injection for code missions

**Files:**

- Modify: `src/main/starbase/hull.ts`
- Modify: `src/main/__tests__/hull.test.ts`

- [ ] **Step 1: Write failing tests for `buildCargoHeader`**

  In `src/main/__tests__/hull.test.ts`, add after the existing `describe('Hull', ...)` block:

  ```typescript
  describe('buildCargoHeader', () => {
    it('returns empty string when mission has no dependencies', () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'Code',
        prompt: 'P',
        type: 'code'
      });
      const header = buildCargoHeader(db.getDb(), mission.id);
      expect(header).toBe('');
    });

    it('returns empty string when dependency has no cargo', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R',
        prompt: 'P',
        type: 'research'
      });
      const code = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      const header = buildCargoHeader(db.getDb(), code.id);
      expect(header).toBe('');
    });

    it('returns empty string when cargo manifest has {content} but no {path}', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R',
        prompt: 'P',
        type: 'research'
      });
      db.getDb()
        .prepare(
          "INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified) VALUES (?, ?, ?, 'documentation_summary', ?, 1)"
        )
        .run('crew-1', r.id, 'api', JSON.stringify({ content: 'some findings' }));
      const code = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      expect(buildCargoHeader(db.getDb(), code.id)).toBe('');
    });

    it('returns empty string when cargo file path does not exist on disk', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R',
        prompt: 'P',
        type: 'research'
      });
      db.getDb()
        .prepare(
          "INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified) VALUES (?, ?, ?, 'documentation_summary', ?, 1)"
        )
        .run('crew-1', r.id, 'api', JSON.stringify({ path: '/nonexistent/path/summary.md' }));
      const code = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      expect(buildCargoHeader(db.getDb(), code.id)).toBe('');
    });

    it('returns header with path when cargo file exists on disk', () => {
      const r = missionSvc.addMission({
        sectorId: 'api',
        summary: 'Investigate auth',
        prompt: 'P',
        type: 'research'
      });
      // Write a real temp file
      const cargoPath = join(tmpdir(), `fleet-test-cargo-${Date.now()}.md`);
      writeFileSync(cargoPath, '## Findings\nsome content');
      db.getDb()
        .prepare(
          "INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified) VALUES (?, ?, ?, 'documentation_summary', ?, 1)"
        )
        .run('crew-1', r.id, 'api', JSON.stringify({ path: cargoPath }));
      const code = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r.id]
      });
      const header = buildCargoHeader(db.getDb(), code.id);
      expect(header).toContain('RESEARCH CONTEXT');
      expect(header).toContain(`Mission #${r.id}`);
      expect(header).toContain('Investigate auth');
      expect(header).toContain(cargoPath);
      // Clean up
      try {
        unlinkSync(cargoPath);
      } catch {}
    });

    it('skips missing-file entries but still produces header for valid ones', () => {
      const r1 = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R1',
        prompt: 'P',
        type: 'research'
      });
      const r2 = missionSvc.addMission({
        sectorId: 'api',
        summary: 'R2',
        prompt: 'P',
        type: 'research'
      });
      // r1 has missing file
      db.getDb()
        .prepare(
          "INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified) VALUES (?, ?, ?, 'documentation_summary', ?, 1)"
        )
        .run('crew-1', r1.id, 'api', JSON.stringify({ path: '/nonexistent/gone.md' }));
      // r2 has real file
      const cargoPath = join(tmpdir(), `fleet-test-cargo2-${Date.now()}.md`);
      writeFileSync(cargoPath, 'findings');
      db.getDb()
        .prepare(
          "INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified) VALUES (?, ?, ?, 'documentation_summary', ?, 1)"
        )
        .run('crew-2', r2.id, 'api', JSON.stringify({ path: cargoPath }));
      const code = missionSvc.addMission({
        sectorId: 'api',
        summary: 'C',
        prompt: 'P',
        type: 'code',
        dependsOnMissionIds: [r1.id, r2.id]
      });
      const header = buildCargoHeader(db.getDb(), code.id);
      expect(header).toContain('RESEARCH CONTEXT');
      expect(header).not.toContain('/nonexistent/gone.md');
      expect(header).toContain(cargoPath);
      try {
        unlinkSync(cargoPath);
      } catch {}
    });
  });
  ```

  Also add `{ unlinkSync }` to the existing `fs` import at the top if not already present, and add `buildCargoHeader` to the Hull import:

  ```typescript
  import { Hull, HullOpts, buildCargoHeader } from '../starbase/hull';
  ```

- [ ] **Step 2: Run to confirm they fail**

  ```bash
  npx vitest run src/main/__tests__/hull.test.ts
  ```

  Expected: new tests FAIL (`buildCargoHeader` not exported).

- [ ] **Step 3: Add `buildCargoHeader` function to `hull.ts`**

  Add the `existsSync` import at the top of `hull.ts` — it already imports `writeFileSync`, `unlinkSync`, `mkdirSync` from `'fs'`, so add `existsSync` to that import:

  ```typescript
  import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
  ```

  Then add `buildCargoHeader` as an **exported** top-level function in `hull.ts`, after the imports and before the `Hull` class:

  ```typescript
  export function buildCargoHeader(db: Database.Database, missionId: number): string {
    const deps = db
      .prepare(
        `SELECT md.depends_on_mission_id, m.summary
         FROM mission_dependencies md
         JOIN missions m ON m.id = md.depends_on_mission_id
         WHERE md.mission_id = ?`
      )
      .all(missionId) as Array<{ depends_on_mission_id: number; summary: string }>;

    if (deps.length === 0) return '';

    const lines: string[] = [];

    for (const dep of deps) {
      const cargo = db
        .prepare(
          `SELECT manifest FROM cargo
           WHERE mission_id = ? AND type = 'documentation_summary' AND verified = 1
           LIMIT 1`
        )
        .get(dep.depends_on_mission_id) as { manifest: string } | undefined;

      if (!cargo) continue;

      let path: string | null = null;
      try {
        const manifest = JSON.parse(cargo.manifest) as { path?: string };
        if (manifest.path && existsSync(manifest.path)) {
          path = manifest.path;
        }
      } catch {
        continue;
      }

      if (!path) continue;

      lines.push(
        `- Mission #${dep.depends_on_mission_id} "${dep.summary}"\n  Summary cargo: ${path}`
      );
    }

    if (lines.length === 0) return '';

    return [
      'RESEARCH CONTEXT: The following research mission(s) completed before this code mission.',
      'Use the Read tool to load their findings if your task requires context.',
      '',
      ...lines,
      ''
    ].join('\n');
  }
  ```

- [ ] **Step 4: Inject header into init message inside `Hull.start()`**

  In `hull.ts`, inside `start()`, find the `initMsg` construction (around line 233). Replace:

  ```typescript
  const initMsg =
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: `${worktreeWarning}${researchGuidance}Read and execute the mission prompt in ${promptFile}. Delete the file when done.`
      },
      parent_tool_use_id: null,
      session_id: ''
    }) + '\n';
  ```

  With:

  ```typescript
  const cargoHeader =
    this.opts.missionType === 'code' || this.opts.missionType == null
      ? buildCargoHeader(db, missionId)
      : '';

  const initMsg =
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: `${cargoHeader}${worktreeWarning}${researchGuidance}Read and execute the mission prompt in ${promptFile}. Delete the file when done.`
      },
      parent_tool_use_id: null,
      session_id: ''
    }) + '\n';
  ```

- [ ] **Step 5: Run tests — all should pass**

  ```bash
  npx vitest run src/main/__tests__/hull.test.ts
  ```

  Expected: all PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/starbase/hull.ts src/main/__tests__/hull.test.ts
  git commit -m "feat(hull): inject research cargo header into code mission init message"
  ```

---

## Task 7: Update workspace templates

**Files:**

- Modify: `src/main/starbase/workspace-templates.ts`
- Modify: `src/main/__tests__/workspace-templates.test.ts`

- [ ] **Step 1: Write failing tests**

  In `src/main/__tests__/workspace-templates.test.ts`, add:

  ```typescript
  it('generateClaudeMd includes Research-First Workflow section', () => {
    const md = generateClaudeMd({ starbaseName: 'test', sectors: [] });
    expect(md).toContain('Research-First Workflow');
    expect(md).toContain('--depends-on');
  });

  it('generateSkillMd includes --depends-on in missions add reference', () => {
    const md = generateSkillMd();
    expect(md).toContain('--depends-on');
    expect(md).toContain('Research-First Workflow');
    expect(md).toContain('summary cargo path is referenced');
  });
  ```

- [ ] **Step 2: Run to confirm they fail**

  ```bash
  npx vitest run src/main/__tests__/workspace-templates.test.ts
  ```

  Expected: new tests FAIL.

- [ ] **Step 3: Update `generateClaudeMd()`**

  In `src/main/starbase/workspace-templates.ts`, find the `## Deployment Workflow (CRITICAL)` section in the template string. After the existing code block that shows the two-step `missions add` / `crew deploy` workflow, add the Research-First Workflow subsection:

  ```typescript
  // Add after the existing two-step workflow block and before "This ensures mission prompts..."
  `
  ### Research-First Workflow (recommended for non-trivial code missions)
  
  For anything beyond a trivial change, create a research mission first to gather context, then create a code mission that depends on it. The code mission will not be scheduled until the research mission reaches a terminal state.
  
  \`\`\`bash
  # 1. Create the research mission
  fleet missions add --sector <id> --type research --summary "Investigate X" --prompt "Investigate..."
  
  # 2. Create the code mission that depends on the research
  fleet missions add --sector <id> --type code --summary "Implement X" --prompt "..." --depends-on <research-mission-id>
  
  # 3. Deploy the research crew first
  fleet crew deploy --sector <id> --mission <research-mission-id>
  
  # 4. When research completes, deploy the code crew
  fleet crew deploy --sector <id> --mission <code-mission-id>
  \`\`\`
  
  When the code crew starts, it receives a header listing the research cargo file paths and can use the Read tool to load findings if the task requires them.
  `;
  ```

- [ ] **Step 4: Update `generateSkillMd()`**

  In the `generateSkillMd()` function, make four targeted changes:

  **a)** In the `### Missions` command reference block, add `--depends-on` line after `missions add`:

  ```
  fleet missions add ... --depends-on <research-id>   # Link a research dependency (can repeat for multiple)
  ```

  **b)** In the `**Required fields for \`missions add\`:\*\*`note, add:`Use \`--depends-on <research-mission-id>\` to attach research dependencies (optional, encouraged for non-trivial changes).`

  **c)** After the `### Mission Scoping & Deployment Workflow` section's existing example, add the same Research-First Workflow section as above.

  **d)** In the `## Research Mission Output Format` section, add at the end:

  ```
  When a research mission completes, its summary cargo path is referenced in the initial message of any code missions that depend on it. The code crew can Read the file on demand if the task requires the findings.
  ```

- [ ] **Step 5: Run tests — all should pass**

  ```bash
  npx vitest run src/main/__tests__/workspace-templates.test.ts
  ```

  Expected: all PASS.

- [ ] **Step 6: Run full test suite to check for regressions**

  ```bash
  npx vitest run
  ```

  Expected: all tests PASS. Fix any regressions before continuing.

- [ ] **Step 7: Commit**

  ```bash
  git add src/main/starbase/workspace-templates.ts src/main/__tests__/workspace-templates.test.ts
  git commit -m "feat(templates): add Research-First Workflow guidance and --depends-on to Admiral templates"
  ```

---

## Task 8: Final regression check

- [ ] **Step 1: Run the full test suite one more time**

  ```bash
  npx vitest run
  ```

  Expected: all tests PASS.

- [ ] **Step 2: Verify migration version is correct**

  The new migration must be version 9. Check `migrations.ts` — the last entry before this change was version 8 (`008-pr-review`). Confirm:

  ```bash
  grep "version:" src/main/starbase/migrations.ts
  ```

  Expected output includes `version: 9` as the last entry.

- [ ] **Step 3: Commit if any final fixes were needed**

  If you made any fixes in step 1, commit them:

  ```bash
  git add -p
  git commit -m "fix: address test regressions from research-backed missions implementation"
  ```
