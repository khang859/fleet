# Repair Mission Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `repair` mission type that lets crew fix CI failures or review comments on an existing PR branch, plus a `prMonitorSweep` that automatically dispatches repair crews when GitHub CI fails on approved missions.

**Architecture:** Eight focused changes: a DB migration adding `original_mission_id`; MissionService accepting it; WorktreeManager running `git worktree prune` before branch checkout; Hull gaining a repair preamble and repair-specific cleanup paths; CrewService guarding repair deployments; Sentinel gaining a 5-minute PR monitor sweep; and the fleet CLI accepting `--type repair` with `--pr-branch`.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, node child_process (`execSync`/`execFileAsync`), `gh` CLI

**Spec:** `docs/superpowers/specs/2026-03-22-repair-mission-type-design.md`

---

## File Map

| File | Change |
|---|---|
| `src/main/starbase/migrations.ts` | Add migration v15: `original_mission_id` column |
| `src/main/starbase/mission-service.ts` | Add `originalMissionId` to `AddMissionOpts` and `INSERT` |
| `src/main/starbase/worktree-manager.ts` | Add `git worktree prune` before `git worktree add` in `createForExistingBranch` |
| `src/main/starbase/hull.ts` | Add `originalMissionId` to `HullOpts`; add `repairPreamble`; add repair paths in `createPR` and `cleanup` |
| `src/main/starbase/crew-service.ts` | Add repair guard (require `prBranch`); pass `originalMissionId` to Hull |
| `src/main/starbase/sentinel.ts` | Add `missionService` to `SentinelDeps`; add `prMonitorSweep()` on 5-min timer |
| `src/main/fleet-cli.ts` | Add `repair` to valid types; add `--pr-branch` and `--original-mission-id` flags |
| `src/main/__tests__/mission-service.test.ts` | Add `originalMissionId` tests |
| `src/main/__tests__/crew-service.test.ts` | Add repair guard tests |
| `src/main/__tests__/sentinel.test.ts` | Add `prMonitorSweep` tests |

---

## Task 1: DB Migration — `original_mission_id` Column

**Files:**
- Modify: `src/main/starbase/migrations.ts`
- Test: `src/main/__tests__/mission-service.test.ts`

- [ ] **Open `src/main/starbase/migrations.ts` and find the last migration (currently v14). Add v15 after it:**

```typescript
{
  version: 15,
  name: '015-original-mission-id',
  sql: `
    ALTER TABLE missions ADD COLUMN original_mission_id INTEGER REFERENCES missions(id);
  `
},
```

- [ ] **Verify the migration runs cleanly:**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Write a test confirming the column exists after migration. Add to `src/main/__tests__/mission-service.test.ts`:**

```typescript
it('should store original_mission_id when provided', () => {
  const parent = missionSvc.addMission({ sectorId: 'api', summary: 'Original', prompt: 'P' });
  const repair = missionSvc.addMission({
    sectorId: 'api',
    summary: 'Fix CI',
    prompt: 'Fix it',
    originalMissionId: parent.id
  });
  const row = missionSvc.getMission(repair.id);
  expect(row!.original_mission_id).toBe(parent.id);
});
```

- [ ] **Run the test and confirm it fails (originalMissionId not yet accepted):**

```bash
npm run typecheck 2>&1 | head -20
```

- [ ] **Commit migration only:**

```bash
git add src/main/starbase/migrations.ts
git commit -m "feat: add original_mission_id column to missions (migration v15)"
```

---

## Task 2: MissionService — `originalMissionId` Support

**Files:**
- Modify: `src/main/starbase/mission-service.ts`
- Test: `src/main/__tests__/mission-service.test.ts`

- [ ] **Open `src/main/starbase/mission-service.ts`. Add `originalMissionId` to `MissionRow` type:**

```typescript
type MissionRow = {
  // ... existing fields ...
  original_mission_id: number | null;  // ADD
};
```

- [ ] **Add `originalMissionId` to `AddMissionOpts`:**

```typescript
type AddMissionOpts = {
  // ... existing fields ...
  originalMissionId?: number;  // ADD
};
```

- [ ] **Update `addMission` INSERT to include the new column:**

```typescript
addMission(opts: AddMissionOpts): MissionRow {
  const result = this.db
    .prepare(
      `INSERT INTO missions (sector_id, summary, prompt, acceptance_criteria, priority, depends_on_mission_id, type, pr_branch, original_mission_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.sectorId,
      opts.summary,
      opts.prompt,
      opts.acceptanceCriteria ?? null,
      opts.priority ?? 0,
      null,
      opts.type ?? 'code',
      opts.prBranch ?? null,
      opts.originalMissionId ?? null  // ADD
    );
  // ... rest unchanged ...
}
```

- [ ] **Run the test from Task 1 and confirm it passes:**

```bash
npx vitest run src/main/__tests__/mission-service.test.ts
```
Expected: all tests pass including the new `original_mission_id` test

- [ ] **Run full typecheck:**

```bash
npm run typecheck
```

- [ ] **Commit:**

```bash
git add src/main/starbase/mission-service.ts src/main/__tests__/mission-service.test.ts
git commit -m "feat: add originalMissionId to MissionService addMission"
```

---

## Task 3: WorktreeManager — `git worktree prune` Fix

**Files:**
- Modify: `src/main/starbase/worktree-manager.ts`

This fixes the `fatal: 'branch' is already checked out at '/old/path'` error caused by stale `.git/worktrees/` metadata from silently-failed worktree removals.

- [ ] **Open `src/main/starbase/worktree-manager.ts`. Find `createForExistingBranch` — the line that calls `git worktree add` (around line 166). Add the prune call immediately before it:**

```typescript
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
```

- [ ] **Run typecheck:**

```bash
npm run typecheck
```

- [ ] **Commit:**

```bash
git add src/main/starbase/worktree-manager.ts
git commit -m "fix: prune stale worktree metadata before createForExistingBranch"
```

---

## Task 4: Hull — `repairPreamble` and `HullOpts.originalMissionId`

**Files:**
- Modify: `src/main/starbase/hull.ts`

- [ ] **Open `src/main/starbase/hull.ts`. Add `originalMissionId` to `HullOpts` (around line 148, after `prBranch`):**

```typescript
/** For repair missions: the original code mission whose PR this crew is fixing */
originalMissionId?: number;
```

- [ ] **Find the preamble construction block (around line 269, where `researchPreamble`, `reviewPreamble`, `architectPreamble` are defined). Add `repairPreamble` after `architectPreamble`:**

```typescript
const repairPreamble =
  this.opts.missionType === 'repair'
    ? `# Repair Mission Instructions

You are a repair crew deployed on a repair mission (FLEET_MISSION_TYPE=repair).
You are working on an existing PR branch — do NOT create a new branch or new PR.

## Your Objective
Fix the issues described in this mission (CI failures and/or review comments).
The PR already exists. Your commits will be pushed to the existing PR branch automatically.

## Workflow
- Read the CI failure output and/or review comments in your mission prompt
- Use \`gh pr view --comments\` to see any additional reviewer feedback
- Use \`gh pr checks\` to see the current CI status
- Fix the identified issues
- Commit your changes — they will be pushed on mission completion

## Constraints
- Do NOT run \`gh pr create\` — the PR already exists
- Do NOT switch branches or create new branches
- Do NOT merge or close the PR
`
    : null;
```

- [ ] **Add `repairPreamble` to the `combinedSystemPrompt` join (find the line joining `researchPreamble`, `reviewPreamble`, `architectPreamble`):**

```typescript
const combinedSystemPrompt = [researchPreamble, reviewPreamble, architectPreamble, repairPreamble, this.opts.systemPrompt]
  .filter(Boolean)
  .join('\n\n');
```

- [ ] **Run typecheck:**

```bash
npm run typecheck
```

- [ ] **Commit:**

```bash
git add src/main/starbase/hull.ts
git commit -m "feat: add originalMissionId to HullOpts and repair preamble"
```

---

## Task 5: CrewService — Repair Guard and `originalMissionId` Propagation

**Files:**
- Modify: `src/main/starbase/crew-service.ts`
- Test: `src/main/__tests__/crew-service.test.ts`

- [ ] **Write a failing test first. Add to `src/main/__tests__/crew-service.test.ts`:**

```typescript
it('should throw when deploying repair mission without prBranch', async () => {
  const missionSvc = new MissionService(db.getDb());
  const mission = missionSvc.addMission({
    sectorId: 'api',
    summary: 'Fix CI',
    prompt: 'Fix it',
    type: 'repair'
  });

  await expect(
    crewSvc.deployCrew({
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'Fix it',
      type: 'repair'
      // no prBranch
    })
  ).rejects.toThrow('Repair mission');
});
```

- [ ] **Run the test to confirm it fails:**

```bash
npx vitest run src/main/__tests__/crew-service.test.ts -t "repair mission without prBranch"
```
Expected: FAIL (no guard exists yet)

- [ ] **Open `src/main/starbase/crew-service.ts`. Find `deployCrew`. Add the repair guard after the existing terminal status and crew_id guards (around line 128):**

```typescript
// Guard: repair missions require prBranch
if (missionType === 'repair' && !opts.prBranch) {
  throw new Error(
    `Repair mission ${missionId} requires a prBranch. Use --pr-branch when creating a repair mission.`
  );
}
```

- [ ] **Find where Hull is constructed in `deployCrew` (the `new Hull({...})` block around line 204). Add `originalMissionId` to the Hull options:**

```typescript
const hull = new Hull({
  // ... existing fields ...
  originalMissionId: missionRow.original_mission_id ?? undefined,  // ADD
});
```

- [ ] **Run the test to confirm it passes:**

```bash
npx vitest run src/main/__tests__/crew-service.test.ts
```

- [ ] **Run typecheck:**

```bash
npm run typecheck
```

- [ ] **Commit:**

```bash
git add src/main/starbase/crew-service.ts src/main/__tests__/crew-service.test.ts
git commit -m "feat: add repair guard and originalMissionId propagation in CrewService"
```

---

## Task 6: Hull — Repair Paths in `createPR` and `cleanup`

**Files:**
- Modify: `src/main/starbase/hull.ts`

There are three repair-specific paths to add:
1. `createPR`: when a repair crew pushes, set the **original** mission to `pending-review` (not the repair mission)
2. `cleanup` no-changes: treat no-changes as success for repair (CI may have self-healed)
3. `cleanup` timeout/error: revert original mission from `repairing` to `ci-failed`

### 6a — `createPR` repair handling

- [ ] **Find `createPR` in hull.ts (around line 1359). Find the existing-PR early-return block (the `gh pr view` check, around line 1441). Replace that block with repair-aware logic:**

```typescript
// Check if PR already exists on this branch (repair/fix crews push to existing PR)
try {
  execSync(`gh pr view "${worktreeBranch}" --json number`, {
    cwd: sectorPath,
    stdio: 'pipe'
  });
  // PR exists — handle based on mission type
  if (this.opts.missionType === 'repair' && this.opts.originalMissionId != null) {
    // Repair crew: transition ORIGINAL mission to pending-review for fresh review
    db.prepare(
      "UPDATE missions SET status = 'pending-review', crew_id = NULL WHERE id = ?"
    ).run(this.opts.originalMissionId);
    // Mark repair mission itself as completed
    db.prepare(
      "UPDATE missions SET status = 'completed', result = 'Repair complete', completed_at = datetime('now') WHERE id = ?"
    ).run(missionId);
  } else {
    // Existing behaviour for non-repair fix crews
    db.prepare(
      "UPDATE missions SET pr_branch = ?, status = 'pending-review', crew_id = NULL WHERE id = ?"
    ).run(worktreeBranch, missionId);
  }
  return;
} catch {
  // No existing PR — continue to create one
}
```

### 6b — `cleanup` no-changes for repair

- [ ] **In `cleanup`, find the `!hasChanges` block. Before the existing `if (this.opts.missionType === 'review')` check, add a repair check:**

```typescript
// Repair: no changes is a valid outcome (CI may have self-healed)
if (this.opts.missionType === 'repair') {
  overrideStatus = 'complete';
  db.prepare(
    "UPDATE missions SET status = 'completed', result = 'No changes needed — CI may have self-healed', completed_at = datetime('now') WHERE id = ?"
  ).run(missionId);
  if (this.opts.originalMissionId != null) {
    db.prepare(
      "UPDATE missions SET status = 'pending-review', crew_id = NULL WHERE id = ?"
    ).run(this.opts.originalMissionId);
  }
  db.prepare(
    "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
  ).run(crewId, JSON.stringify({ missionId, status: 'completed', reason: 'No changes needed' }));
  return;
}
```

### 6c — `cleanup` timeout/error revert for repair

- [ ] **Find the review crew timeout handler in `cleanup` (around line 690 — the `if (this.opts.missionType === 'review' && status === 'timeout')` block). Add a parallel repair handler immediately after it:**

```typescript
// Repair crew timeout or error: revert original mission so prMonitorSweep can retry
if (this.opts.missionType === 'repair' && this.opts.originalMissionId != null &&
    (status === 'timeout' || status === 'error')) {
  db.prepare(
    "UPDATE missions SET status = 'ci-failed' WHERE id = ? AND status = 'repairing'"
  ).run(this.opts.originalMissionId);
  db.prepare(
    "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'repair_failed', ?)"
  ).run(crewId, JSON.stringify({ missionId, originalMissionId: this.opts.originalMissionId, reason: status }));
}
```

- [ ] **Run typecheck:**

```bash
npm run typecheck
```

- [ ] **Commit:**

```bash
git add src/main/starbase/hull.ts
git commit -m "feat: add repair-specific paths in Hull createPR and cleanup"
```

---

## Task 7: Sentinel — `prMonitorSweep`

**Files:**
- Modify: `src/main/starbase/sentinel.ts`
- Test: `src/main/__tests__/sentinel.test.ts`

### 7a — Add `missionService` to `SentinelDeps` and 5-min timer

- [ ] **Open `src/main/starbase/sentinel.ts`. Add `MissionService` import at the top:**

```typescript
import type { MissionService } from './mission-service';
```

- [ ] **Add `missionService` to `SentinelDeps` type:**

```typescript
type SentinelDeps = {
  // ... existing fields ...
  missionService?: MissionService;  // ADD
};
```

- [ ] **Add a private timer field to the `Sentinel` class (alongside `private interval`):**

```typescript
private prMonitorInterval: ReturnType<typeof setInterval> | null = null;
```

- [ ] **Update `start()` to also start the PR monitor timer (5-minute interval):**

```typescript
start(intervalMs?: number): void {
  const ms = intervalMs ?? this.deps.configService.getNumber('lifesign_interval_sec') * 1000;
  this.interval = setInterval(() => {
    this.runSweep().catch((err) => {
      console.error('[sentinel] Sweep failed:', err);
    });
  }, ms);

  // PR monitor runs every 5 minutes — separate timer to avoid GitHub API rate limits
  this.prMonitorInterval = setInterval(() => {
    this.prMonitorSweep().catch((err) => {
      console.error('[sentinel] prMonitorSweep failed:', err);
    });
  }, 5 * 60 * 1000);
}
```

- [ ] **Update `stop()` to clear the new timer:**

```typescript
stop(): void {
  if (this.interval) {
    clearInterval(this.interval);
    this.interval = null;
  }
  if (this.prMonitorInterval) {
    clearInterval(this.prMonitorInterval);
    this.prMonitorInterval = null;
  }
}
```

### 7b — Add `ApprovedMissionRow` type and `prMonitorSweep` method

- [ ] **Add a type for approved missions near the other row types at the top of sentinel.ts:**

```typescript
type ApprovedMissionRow = {
  id: number;
  sector_id: string;
  summary: string;
  prompt: string;
  pr_branch: string;
  review_round: number;
};
```

- [ ] **Add the `MAX_REPAIR_ROUNDS` constant near the top of the class or as a module constant:**

```typescript
const MAX_REPAIR_ROUNDS = 2;
```

- [ ] **Add the `prMonitorSweep` method to the `Sentinel` class (add after `reviewSweep`):**

```typescript
private async prMonitorSweep(): Promise<void> {
  const { db, crewService, missionService } = this.deps;
  if (!crewService || !missionService) return;

  // Guard: gh must be available for GitHub API calls
  if (!Hull.isGhAvailable()) return;

  const missions = db
    .prepare<[], ApprovedMissionRow>(
      `SELECT id, sector_id, summary, prompt, pr_branch, review_round
       FROM missions
       WHERE pr_branch IS NOT NULL
         AND status IN ('approved', 'ci-failed')
         AND type = 'code'`
    )
    .all();

  for (const mission of missions) {
    try {
      await this.checkAndRepairMission(mission, crewService, missionService);
    } catch (err) {
      console.error(`[sentinel] prMonitorSweep error for mission ${mission.id}:`, err);
      // Continue checking other missions
    }
  }
}

private async checkAndRepairMission(
  mission: ApprovedMissionRow,
  crewService: import('./crew-service').CrewService,
  missionService: import('./mission-service').MissionService
): Promise<void> {
  const { db } = this;

  // Escalate if max repair rounds exceeded
  if (mission.review_round >= MAX_REPAIR_ROUNDS) {
    db.prepare("UPDATE missions SET status = 'escalated' WHERE id = ?").run(mission.id);
    db.prepare(
      `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
       VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
    ).run(
      mission.id,
      JSON.stringify({
        missionId: mission.id,
        eventType: 'repair-escalation',
        summary: `Mission #${mission.id} has hit max repair rounds (${MAX_REPAIR_ROUNDS}) — manual intervention needed`
      })
    );
    return;
  }

  // Check CI status via gh CLI
  let ciOutput: string;
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'checks', mission.pr_branch,
      '--json', 'name,state,conclusion,required'
    ]);
    ciOutput = stdout;
  } catch {
    // PR may be closed, branch deleted, or gh not authenticated — skip silently
    return;
  }

  let checks: Array<{ name: string; state: string; conclusion: string; required: boolean }>;
  try {
    checks = JSON.parse(ciOutput);
  } catch {
    return;
  }

  const hasFailure = checks.some(
    (c) => c.required && c.conclusion === 'failure'
  );
  if (!hasFailure) return;

  // Fetch CI failure log
  let failureLog = '(could not fetch CI logs)';
  try {
    const { stdout: runList } = await execFileAsync('gh', [
      'run', 'list',
      '--branch', mission.pr_branch,
      '--json', 'databaseId',
      '--limit', '1'
    ]);
    const runs: Array<{ databaseId: number }> = JSON.parse(runList);
    if (runs[0]) {
      const { stdout: log } = await execFileAsync('gh', [
        'run', 'view', String(runs[0].databaseId), '--log-failed'
      ]);
      failureLog = log.slice(0, 4000);
    }
  } catch {
    // Best-effort — proceed with placeholder log
  }

  // Atomically claim the mission — prevents race with Admiral manual deploy
  const claim = db
    .prepare(
      "UPDATE missions SET status = 'repairing', review_round = review_round + 1 WHERE id = ? AND status IN ('approved', 'ci-failed')"
    )
    .run(mission.id);
  if (claim.changes === 0) return; // Another process claimed it

  // Build repair prompt
  const repairPrompt = [
    mission.prompt,
    '',
    '---',
    '',
    '## Repair Context',
    '',
    `**Reason:** CI failure detected on PR branch \`${mission.pr_branch}\``,
    `**Repair round:** ${mission.review_round + 1}`,
    '',
    '## CI Failure Output',
    '',
    failureLog,
    '',
    'Push your fixes to the current branch — the PR already exists and will be updated automatically.',
    'Do NOT create a new PR.',
  ].join('\n');

  // Create repair mission
  let repairMission;
  try {
    repairMission = missionService.addMission({
      sectorId: mission.sector_id,
      type: 'repair',
      summary: `Fix CI failures: ${mission.summary}`,
      prompt: repairPrompt,
      prBranch: mission.pr_branch,
      originalMissionId: mission.id
    });
  } catch (err) {
    // Rollback
    db.prepare("UPDATE missions SET status = 'ci-failed' WHERE id = ? AND status = 'repairing'").run(mission.id);
    throw err;
  }

  // Deploy repair crew
  try {
    await crewService.deployCrew({
      sectorId: mission.sector_id,
      missionId: repairMission.id,
      prompt: repairMission.prompt,
      prBranch: mission.pr_branch,
      type: 'repair'
    });
  } catch (err) {
    // Rollback original mission and remove orphaned repair mission
    db.prepare("UPDATE missions SET status = 'ci-failed' WHERE id = ? AND status = 'repairing'").run(mission.id);
    db.prepare('DELETE FROM missions WHERE id = ?').run(repairMission.id);
    throw err;
  }
}
```

**Note:** The `Hull` import for `isGhAvailable()` — check if Hull is already imported in sentinel.ts. If not, add: `import { Hull } from './hull';`

### 7c — Write Sentinel tests for `prMonitorSweep`

- [ ] **Add to `src/main/__tests__/sentinel.test.ts`. First add helpers for inserting missions:**

```typescript
function insertMission(opts: {
  sectorId: string;
  summary: string;
  prompt: string;
  status: string;
  type?: string;
  prBranch?: string | null;
  reviewRound?: number;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO missions (sector_id, summary, prompt, status, type, pr_branch, review_round)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.sectorId,
      opts.summary,
      opts.prompt,
      opts.status,
      opts.type ?? 'code',
      opts.prBranch ?? null,
      opts.reviewRound ?? 0
    );
  return Number(result.lastInsertRowid);
}
```

- [ ] **Add tests for the `prMonitorSweep` escalation path (no gh subprocess needed for this path):**

```typescript
describe('prMonitorSweep — escalation', () => {
  it('should escalate mission when review_round >= MAX_REPAIR_ROUNDS', async () => {
    insertSector('api', join(TEST_DIR, 'workspace', 'api'));
    const missionId = insertMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'Fix',
      status: 'approved',
      prBranch: 'feat/test',
      reviewRound: 2  // at max
    });

    const mockCrewService = { deployCrew: vi.fn() } as any;
    const mockMissionService = { addMission: vi.fn() } as any;

    const sentinel = new Sentinel({
      db: getDb(),
      configService,
      crewService: mockCrewService,
      missionService: mockMissionService
    });

    // Directly invoke the private method via any-cast
    await (sentinel as any).prMonitorSweep();

    const mission = getDb()
      .prepare<[number], { status: string }>('SELECT status FROM missions WHERE id = ?')
      .get(missionId);
    expect(mission!.status).toBe('escalated');
    expect(mockCrewService.deployCrew).not.toHaveBeenCalled();
  });
});
```

- [ ] **Run the tests:**

```bash
npx vitest run src/main/__tests__/sentinel.test.ts
```
Expected: new tests pass

- [ ] **Run full typecheck:**

```bash
npm run typecheck
```

- [ ] **Commit:**

```bash
git add src/main/starbase/sentinel.ts src/main/__tests__/sentinel.test.ts
git commit -m "feat: add prMonitorSweep to Sentinel for automated CI failure repair"
```

---

## Task 8: fleet-cli.ts — Repair Type and `--pr-branch` Flag

**Files:**
- Modify: `src/main/fleet-cli.ts`

- [ ] **Open `src/main/fleet-cli.ts`. Find the `mission.create` case (around line 421). Update the usage string and type validation to include `repair`:**

```typescript
const usage =
  'Usage: fleet missions add --sector <id> --type <code|research|review|architect|repair> --summary "short title" --prompt "detailed instructions"';

// Update the type validation error message:
if (!['code', 'research', 'review', 'architect', 'repair'].includes(toStr(args.type))) {
  return (
    'Error: missions add requires --type <code|research|review|architect|repair>.\n\n' +
    'Mission types:\n' +
    '  code      — produces git commits (code changes, bug fixes, features)\n' +
    '  research  — produces documentation artifacts (investigation, analysis, no git changes expected)\n' +
    '  review    — performs PR code review, produces a VERDICT\n' +
    '  architect — analyzes the codebase and produces an implementation blueprint (no git changes)\n' +
    '  repair    — fixes CI failures or review comments on an existing PR branch (requires --pr-branch)\n\n' +
    usage
  );
}
```

- [ ] **Find where `prBranch` is extracted from args and passed to `missionService.addMission` (search for `args['pr-branch']` or `prBranch`). Add `originalMissionId` extraction alongside it:**

```typescript
// These should already exist or be added:
const prBranch = args['pr-branch'] ? toStr(args['pr-branch']) : undefined;
const originalMissionId = args['original-mission-id']
  ? Number(args['original-mission-id'])
  : undefined;
```

- [ ] **Add a repair-specific guard in `mission.create` to enforce `--pr-branch` for repair type:**

```typescript
if (toStr(args.type) === 'repair' && !prBranch) {
  return `Error: --type repair requires --pr-branch <branch-name>.\n\nUsage: fleet missions add --type repair --pr-branch <branch> --sector <id> --summary "..." --prompt "..."`;
}
```

- [ ] **Ensure `prBranch` and `originalMissionId` are passed to `addMission` (find the `addMission` call in the `mission.create` case and add them).**

- [ ] **Update the help text strings (search for `code|research|review|architect` — there are several occurrences in the help output). Replace all with `code|research|review|architect|repair`:**

```bash
grep -n "code|research|review|architect" src/main/fleet-cli.ts
```
Update each occurrence to include `|repair`.

- [ ] **Run typecheck:**

```bash
npm run typecheck
```

- [ ] **Run the full test suite:**

```bash
npx vitest run
```
Expected: all tests pass

- [ ] **Commit:**

```bash
git add src/main/fleet-cli.ts
git commit -m "feat: add repair type and --pr-branch flag to fleet-cli missions add"
```

---

## Task 9: Final Verification

- [ ] **Run full typecheck:**

```bash
npm run typecheck
```
Expected: zero errors

- [ ] **Run full test suite:**

```bash
npx vitest run
```
Expected: all tests pass

- [ ] **Run lint:**

```bash
npm run lint
```
Expected: no lint errors

- [ ] **Verify workspace-templates.ts already updated (done in brainstorming):**

```bash
grep -c "repair" src/main/starbase/workspace-templates.ts
```
Expected: several matches (already committed)

- [ ] **Final commit if any loose files:**

```bash
git status
```
If clean: done. If not: commit remaining changes.
