# First Officer Automated PR Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate PR code review so the First Officer dispatches review crews via Sentinel, with fix crews for changes-requested and escalation to Admiral after 2 rounds.

**Architecture:** Sentinel gets a new `reviewSweep()` that watches `pending-review` and `changes-requested` missions, deploying review or fix crews directly via CrewService. Hull gets a `'review'` mission type path in `cleanup()` that parses verdicts instead of pushing code. WorktreeManager gets a method to check out existing branches.

**Tech Stack:** TypeScript, better-sqlite3, node child_process, git CLI, gh CLI

**Spec:** `docs/superpowers/specs/2026-03-19-fo-pr-review-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/main/starbase/migrations.ts` | Modify | Add migration 008 with `review_round` and `pr_branch` columns, `review_crew_max_concurrent` config |
| `src/main/starbase/mission-service.ts` | Modify | Add `review_round`/`pr_branch` to MissionRow, add `setPrBranch()` method |
| `src/main/starbase/worktree-manager.ts` | Modify | Add `createForExistingBranch()` method |
| `src/main/starbase/hull.ts` | Modify | Add `prBranch` to HullOpts, review mission cleanup path, store `pr_branch` in `createPR()`, remove `admiral-review` gate |
| `src/main/starbase/crew-service.ts` | Modify | Accept `prBranch` in deploy opts, conditional worktree creation, skip deps for review |
| `src/main/starbase/sentinel.ts` | Modify | Add `reviewSweep()`, wire into `runSweep()` before `firstOfficerSweep()` |
| `src/main/socket-server.ts` | Modify | Add `mission.verdict` handler |
| `src/main/fleet-cli.ts` | Modify | Add `missions.verdict` CLI mapping and validation |
| `src/renderer/src/components/star-command/CrewPanel.tsx` | Modify | Add status color mappings for new statuses |

---

### Task 1: Database Migration — Add `review_round`, `pr_branch` columns and config

**Files:**
- Modify: `src/main/starbase/migrations.ts:183` (after migration 007)

- [ ] **Step 1: Add migration 008**

In `migrations.ts`, add a new migration entry after the existing migration 007:

```typescript
{
  version: 8,
  name: '008-pr-review',
  sql: `
    ALTER TABLE missions ADD COLUMN review_round INTEGER DEFAULT 0;
    ALTER TABLE missions ADD COLUMN pr_branch TEXT;
  `
}
```

- [ ] **Step 2: Add config default**

In `CONFIG_DEFAULTS` at the bottom of `migrations.ts`, add:

```typescript
review_crew_max_concurrent: 2,
```

- [ ] **Step 3: Verify the app starts cleanly**

Run: `npm run build` (or the project's build command)
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/migrations.ts
git commit -m "feat(starbase): add migration 008 for PR review columns and config"
```

---

### Task 2: MissionService — Add `review_round`, `pr_branch` to type and new methods

**Files:**
- Modify: `src/main/starbase/mission-service.ts:4-22` (MissionRow type)
- Modify: `src/main/starbase/mission-service.ts:151` (after setReviewVerdict)

- [ ] **Step 1: Update MissionRow type**

Add two fields to the `MissionRow` type at line 4:

```typescript
review_round: number
pr_branch: string | null
```

- [ ] **Step 2: Add `setPrBranch()` method**

After `setReviewVerdict()` (line 155), add:

```typescript
setPrBranch(missionId: number, prBranch: string): void {
  this.db
    .prepare('UPDATE missions SET pr_branch = ? WHERE id = ?')
    .run(prBranch, missionId)
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/mission-service.ts
git commit -m "feat(starbase): add review_round and pr_branch to MissionService"
```

Note: `review_round` is incremented via raw SQL in Hull's review cleanup path (consistent with Hull's existing pattern of using direct DB access instead of service methods). `missions list` and `missions show` automatically pick up the new columns via `SELECT *` queries — no CLI changes needed.

---

### Task 3: WorktreeManager — Add `createForExistingBranch()` method

**Files:**
- Modify: `src/main/starbase/worktree-manager.ts:109` (after `create()` method)

- [ ] **Step 1: Add `createForExistingBranch()` method**

After the `create()` method (line 109), add:

```typescript
async createForExistingBranch(opts: CreateOpts & { existingBranch: string }): Promise<CreateResult> {
  const { starbaseId, crewId, sectorPath, existingBranch } = opts;
  const execOpts = { cwd: sectorPath };

  // Check concurrency limit (same as create())
  if (this.db && this.maxConcurrent < Infinity) {
    const activeCount = (
      this.db
        .prepare("SELECT COUNT(*) as cnt FROM crew WHERE status = 'active' AND worktree_path IS NOT NULL")
        .get() as { cnt: number }
    ).cnt;
    if (activeCount >= this.maxConcurrent) {
      throw new WorktreeLimitError(
        `Worktree limit reached: ${activeCount}/${this.maxConcurrent} active`,
      );
    }
  }

  // Pre-flight: verify git repo
  try {
    await execAsync('git rev-parse --git-dir', execOpts);
  } catch {
    throw new Error(`Not a git repository: ${sectorPath}`);
  }

  // Fetch the branch from origin to ensure it exists locally as a proper tracking branch
  try {
    await execAsync(`git fetch origin "${existingBranch}":"${existingBranch}"`, execOpts);
  } catch {
    // Branch may already exist locally — try to update it
    try {
      await execAsync(`git fetch origin "${existingBranch}"`, execOpts);
    } catch {
      throw new Error(`Failed to fetch branch: ${existingBranch}`);
    }
  }

  const worktreeDir = join(this.worktreeBasePath, starbaseId);
  mkdirSync(worktreeDir, { recursive: true });
  const worktreePath = join(worktreeDir, crewId);

  // Create worktree from existing branch (no -b flag)
  await execAsync(`git worktree add "${worktreePath}" "${existingBranch}"`, execOpts);

  return { worktreePath, worktreeBranch: existingBranch };
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add src/main/starbase/worktree-manager.ts
git commit -m "feat(starbase): add createForExistingBranch() to WorktreeManager"
```

---

### Task 4: Hull — Add review mission cleanup path and store `pr_branch`

**Files:**
- Modify: `src/main/starbase/hull.ts:32-63` (HullOpts type)
- Modify: `src/main/starbase/hull.ts:482` (cleanup — review path in `!hasChanges` block)
- Modify: `src/main/starbase/hull.ts:848-880` (createPR — remove admiral-review gate, always set pending-review, store pr_branch)

- [ ] **Step 1: Add `prBranch` to HullOpts**

In the `HullOpts` type (line 32), add after `missionType`:

```typescript
/** PR branch name for review/fix crews working on an existing PR */
prBranch?: string
```

- [ ] **Step 2: Add review mission cleanup path**

In `cleanup()`, right after the `!hasChanges` check at line 482, add a new early-return arm for review missions BEFORE the existing research/code checks. Insert before line 483 (`if (status !== 'aborted') {`):

```typescript
if (!hasChanges) {
  // Review mission: parse verdict from output, skip all git operations
  if (this.opts.missionType === 'review') {
    overrideStatus = 'complete'
    const fullOutput = this.outputLines.join('\n')
    const verdictMatch = fullOutput.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|ESCALATE)/i)
    const notesMatch = fullOutput.match(/NOTES:\s*([\s\S]*?)(?:\n\n|$)/)
    const verdict = verdictMatch?.[1]?.toLowerCase().replace('_', '-') ?? 'escalate'
    const notes = notesMatch?.[1]?.trim() ?? fullOutput.slice(-2000)

    // Map verdict to mission status
    const statusMap: Record<string, string> = {
      'approve': 'approved',
      'request-changes': 'changes-requested',
      'escalate': 'escalated',
    }
    const missionStatus = statusMap[verdict] ?? 'escalated'

    // Set review verdict and mission status
    db.prepare('UPDATE missions SET review_verdict = ?, review_notes = ?, status = ? WHERE id = ?')
      .run(verdict, notes, missionStatus, missionId)

    // Increment review_round when changes requested
    if (missionStatus === 'changes-requested') {
      db.prepare('UPDATE missions SET review_round = review_round + 1 WHERE id = ?')
        .run(missionId)
    }

    // Send review_verdict comms to Admiral
    db.prepare(
      "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'review_verdict', ?)"
    ).run(crewId, JSON.stringify({ missionId, verdict, notes: notes.slice(0, 2000) }))

    // If escalated, write a memo
    if (missionStatus === 'escalated') {
      const memoDir = join(
        process.env.HOME ?? '~', '.fleet', 'starbases',
        `starbase-${this.opts.starbaseId}`, 'first-officer', 'memos'
      )
      mkdirSync(memoDir, { recursive: true })
      const memoId = `review-${missionId}-${Date.now()}`
      const memoPath = join(memoDir, `${memoId}.md`)
      const memoContent = `## Review Escalation: Mission #${missionId}\n\n**Verdict:** ${verdict}\n**Branch:** ${this.opts.prBranch ?? worktreeBranch}\n\n### Review Notes\n${notes}\n`
      writeFileSync(memoPath, memoContent, 'utf-8')
      db.prepare(
        "INSERT INTO memos (id, crew_id, mission_id, event_type, file_path, status) VALUES (?, ?, ?, 'review-escalation', ?, 'unread')"
      ).run(memoId, crewId, missionId, memoPath)
    }

    // Log exit
    db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
      crewId,
      JSON.stringify({ status: 'complete', reason: `Review verdict: ${verdict}` })
    )
    return
  }

  if (status !== 'aborted') {
```

Note: The existing `if (status !== 'aborted') {` line stays — we're adding the review block before it. Also handle the review crew timeout case: in the timeout handling section of cleanup, when `missionType === 'review'` and status is `timeout`, set mission to `escalated` instead of `failed`:

At the top of `cleanup()` after `this.status = status` (line 424), add:

```typescript
// Review crew timeout → escalate instead of entering failure-triage
if (this.opts.missionType === 'review' && status === 'timeout') {
  db.prepare("UPDATE missions SET status = 'escalated', result = 'Review crew timed out' WHERE id = ?")
    .run(missionId)
  db.prepare(
    "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'review_verdict', ?)"
  ).run(crewId, JSON.stringify({ missionId, verdict: 'escalated', notes: 'Review crew timed out' }))
}
```

- [ ] **Step 3: Modify `createPR()` — always set `pending-review` and store `pr_branch`**

In `createPR()` at line 848, replace the `admiral-review` conditional block:

```typescript
// Gate 3: If review_mode is admiral-review, send pr_review_request comms
if (this.opts.reviewMode === 'admiral-review') {
```

With unconditional logic (remove the `if` guard):

```typescript
// Store PR branch and set pending-review for automated FO review
try {
  const prViewOutput = execSync(`gh pr view "${worktreeBranch}" --json number,url`, {
    cwd: sectorPath,
    stdio: 'pipe'
  }).toString()
  const prData = JSON.parse(prViewOutput) as { number: number; url: string }

  // Store pr_branch on mission for review/fix crews
  db.prepare('UPDATE missions SET pr_branch = ? WHERE id = ?').run(worktreeBranch, missionId)

  // Send pr_review_request comms to Admiral
  const missionRow = db
    .prepare('SELECT acceptance_criteria FROM missions WHERE id = ?')
    .get(missionId) as { acceptance_criteria: string | null } | undefined

  db.prepare(
    "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'pr_review_request', ?)"
  ).run(
    crewId,
    JSON.stringify({
      prNumber: prData.number,
      prUrl: prData.url,
      missionId,
      diffSummary: diffStat.slice(0, 2000),
      acceptanceCriteria: missionRow?.acceptance_criteria ?? ''
    })
  )

  // Update mission status to pending-review
  db.prepare("UPDATE missions SET status = 'pending-review' WHERE id = ?").run(missionId)
} catch {
  // PR view failed — skip review request, continue normally
}
```

- [ ] **Step 4: Handle existing PR detection for fix crews**

In `createPR()`, before the `gh pr create` call (line 843), add a check for an existing PR on the branch:

```typescript
// Check if PR already exists on this branch (fix crews push to existing PR)
try {
  execSync(`gh pr view "${worktreeBranch}" --json number`, {
    cwd: sectorPath,
    stdio: 'pipe'
  })
  // PR exists — store pr_branch and set pending-review, skip creating a new PR
  db.prepare('UPDATE missions SET pr_branch = ?, status = \'pending-review\' WHERE id = ?')
    .run(worktreeBranch, missionId)
  return
} catch {
  // No existing PR — continue to create one
}
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/hull.ts
git commit -m "feat(starbase): add review mission cleanup path and universal pending-review in Hull"
```

---

### Task 5: CrewService — Support `prBranch` in deployment

**Files:**
- Modify: `src/main/starbase/crew-service.ts:71-72` (deployCrew opts type)
- Modify: `src/main/starbase/crew-service.ts:106-135` (worktree creation and dep install)
- Modify: `src/main/starbase/crew-service.ts:144-168` (Hull construction)

- [ ] **Step 1: Update `deployCrew()` opts type**

Change the opts parameter at line 72:

```typescript
async deployCrew(
  opts: { sectorId: string; prompt: string; missionId: number; type?: string; prBranch?: string },
): Promise<DeployResult> {
```

- [ ] **Step 2: Conditional worktree creation**

Replace the worktree creation block (lines 107-126) with:

```typescript
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
```

- [ ] **Step 3: Skip dependency install for review crews**

Replace the dependency install block (lines 129-135) with:

```typescript
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
```

- [ ] **Step 4: Pass `prBranch` to Hull**

In the Hull constructor call (line 144), add `prBranch`:

```typescript
prBranch: opts.prBranch,
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/crew-service.ts
git commit -m "feat(starbase): support prBranch in crew deployment for review/fix crews"
```

---

### Task 6: Sentinel — Add `reviewSweep()`

**Files:**
- Modify: `src/main/starbase/sentinel.ts:72-188` (runSweep method)
- Modify: `src/main/starbase/sentinel.ts:250-337` (firstOfficerSweep — update `review-rejected` to `changes-requested`)

- [ ] **Step 1: Add `reviewSweep()` to runSweep before firstOfficerSweep**

In `runSweep()`, before the existing firstOfficerSweep call at line 185, add:

```typescript
// 9. PR Review sweep — dispatch review/fix crews for pending-review and changes-requested missions
if (this.deps.crewService) {
  await this.reviewSweep()
}

// 10. First Officer triage — detect actionable failures and dispatch
```

Update the existing comment numbering from 9 to 10.

- [ ] **Step 2: Add the `reviewSweep()` method**

Add after the `firstOfficerSweep()` method (before `pingSocket()`):

```typescript
private async reviewSweep(): Promise<void> {
  const { db, configService, crewService } = this.deps
  if (!crewService) return

  const maxConcurrent = (configService.get('review_crew_max_concurrent') as number) ?? 2

  // Count active review crews
  const activeReviewCount = (
    db.prepare(
      "SELECT COUNT(*) as cnt FROM crew c JOIN missions m ON m.id = c.mission_id WHERE c.status = 'active' AND m.type = 'review'"
    ).get() as { cnt: number }
  ).cnt

  if (activeReviewCount >= maxConcurrent) return

  // Find missions needing review
  const pendingReview = db.prepare(
    `SELECT m.id, m.sector_id, m.summary, m.acceptance_criteria, m.pr_branch,
            m.review_round, m.review_notes,
            s.base_branch, s.verify_command, s.name as sector_name
     FROM missions m
     JOIN sectors s ON s.id = m.sector_id
     WHERE m.status = 'pending-review'
       AND m.pr_branch IS NOT NULL
     ORDER BY m.priority ASC, m.completed_at ASC
     LIMIT ?`
  ).all(maxConcurrent - activeReviewCount) as Array<{
    id: number
    sector_id: string
    summary: string
    acceptance_criteria: string | null
    pr_branch: string
    review_round: number
    review_notes: string | null
    base_branch: string
    verify_command: string | null
    sector_name: string
  }>

  for (const mission of pendingReview) {
    // Transition to reviewing (dedup guard)
    db.prepare("UPDATE missions SET status = 'reviewing' WHERE id = ? AND status = 'pending-review'").run(mission.id)
    const changed = db.prepare('SELECT changes() as c').get() as { c: number }
    if (changed.c === 0) continue // Another sweep already claimed it

    // Build review prompt
    const reviewPrompt = `Review the PR on branch \`${mission.pr_branch}\` targeting \`${mission.base_branch}\`.

## Mission Context
Summary: ${mission.summary}
Acceptance Criteria: ${mission.acceptance_criteria ?? 'None specified'}

## Instructions
1. Run the verify command to check tests pass
2. Read the diff: \`git diff ${mission.base_branch}...${mission.pr_branch}\`
3. Review against acceptance criteria and code quality
4. Check for: logic errors, security issues, missing tests, convention violations, unnecessary complexity
5. Only report issues you are >=80% confident about
6. Output your verdict in this exact format:

VERDICT: APPROVE | REQUEST_CHANGES | ESCALATE
NOTES: <your review notes — specific file:line references for issues>`

    try {
      await crewService.deployCrew({
        sectorId: mission.sector_id,
        prompt: reviewPrompt,
        missionId: mission.id,
        type: 'review',
        prBranch: mission.pr_branch,
      })

      db.prepare(
        "INSERT INTO ships_log (event_type, detail) VALUES ('review_crew_dispatched', ?)"
      ).run(JSON.stringify({ missionId: mission.id, prBranch: mission.pr_branch }))
    } catch (err) {
      // Deployment failed — revert to pending-review so next sweep retries
      db.prepare("UPDATE missions SET status = 'pending-review' WHERE id = ?").run(mission.id)
      console.error(`[sentinel] Review crew deploy failed for mission ${mission.id}:`, err)
    }
  }

  // Find missions needing fix crews (changes-requested)
  const changesRequested = db.prepare(
    `SELECT m.id, m.sector_id, m.summary, m.prompt, m.acceptance_criteria,
            m.pr_branch, m.review_round, m.review_notes,
            s.base_branch, s.name as sector_name
     FROM missions m
     JOIN sectors s ON s.id = m.sector_id
     WHERE m.status = 'changes-requested'
       AND m.pr_branch IS NOT NULL
     ORDER BY m.priority ASC
     LIMIT 5`
  ).all() as Array<{
    id: number
    sector_id: string
    summary: string
    prompt: string
    acceptance_criteria: string | null
    pr_branch: string
    review_round: number
    review_notes: string | null
    base_branch: string
    sector_name: string
  }>

  for (const mission of changesRequested) {
    // Check max review rounds
    if (mission.review_round >= 2) {
      db.prepare("UPDATE missions SET status = 'escalated' WHERE id = ?").run(mission.id)

      // Send escalation comms
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES ('first-officer', 'admiral', 'review_escalated', ?)"
      ).run(JSON.stringify({
        missionId: mission.id,
        reason: `Max review rounds (${mission.review_round}) reached`,
        reviewNotes: mission.review_notes,
        prBranch: mission.pr_branch,
      }))

      db.prepare(
        "INSERT INTO ships_log (event_type, detail) VALUES ('review_escalated', ?)"
      ).run(JSON.stringify({ missionId: mission.id, reviewRound: mission.review_round }))
      continue
    }

    // Deploy fix crew on the same PR branch
    // Transition to active (consumed by deployCrew via activateMission)
    const fixPrompt = `Fix the issues identified in the PR review for branch \`${mission.pr_branch}\`.

## Original Mission
Summary: ${mission.summary}
Acceptance Criteria: ${mission.acceptance_criteria ?? 'None specified'}

## Review Feedback (Round ${mission.review_round})
${mission.review_notes ?? 'No specific notes provided'}

## Instructions
1. Read the review feedback carefully
2. Address each issue mentioned
3. Run the verify command to ensure tests still pass
4. Commit and push your fixes to the existing branch`

    try {
      await crewService.deployCrew({
        sectorId: mission.sector_id,
        prompt: fixPrompt,
        missionId: mission.id,
        type: 'code',
        prBranch: mission.pr_branch,
      })

      db.prepare(
        "INSERT INTO ships_log (event_type, detail) VALUES ('fix_crew_dispatched', ?)"
      ).run(JSON.stringify({ missionId: mission.id, prBranch: mission.pr_branch, round: mission.review_round }))
    } catch (err) {
      // Deploy failed — leave as changes-requested for next sweep
      console.error(`[sentinel] Fix crew deploy failed for mission ${mission.id}:`, err)
    }
  }
}
```

- [ ] **Step 3: Update `firstOfficerSweep()` — remove `review-rejected` from query**

`changes-requested` missions are handled by `reviewSweep()`, not `firstOfficerSweep()`. Remove `review-rejected` from the query entirely.

In the SQL query at line 267, change:

```sql
AND m.status IN ('failed', 'failed-verification', 'review-rejected')
```

to:

```sql
AND m.status IN ('failed', 'failed-verification')
```

And at line 314-315, remove the `review-rejected` eventType mapping:

```typescript
// Before:
eventType: row.mission_status === 'failed-verification' ? 'verification-failed'
  : row.mission_status === 'review-rejected' ? 'review-rejected' : 'error',

// After:
eventType: row.mission_status === 'failed-verification' ? 'verification-failed' : 'error',
```

Note: `sentinel.ts` already imports `join` from `'path'` at line 6 — no new import needed.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/sentinel.ts
git commit -m "feat(starbase): add reviewSweep() to Sentinel for automated PR review dispatch"
```

---

### Task 7: CLI — Add `missions verdict` command

**Files:**
- Modify: `src/main/socket-server.ts` (add `mission.verdict` handler)
- Modify: `src/main/fleet-cli.ts` (add CLI mapping and validation)

- [ ] **Step 1: Add `mission.verdict` handler to socket server**

In `socket-server.ts`, after the `mission.cancel` case block, add:

```typescript
case 'mission.verdict': {
  const rawId = args.id ?? args.missionId;
  if (rawId == null) {
    const err = new Error(
      'mission.verdict requires a mission ID.\n' +
      'Usage: fleet missions verdict <mission-id> --verdict <approved|changes-requested|escalated> --notes "..."'
    ) as Error & { code: string };
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const id = typeof rawId === 'string' ? parseInt(rawId, 10) : (rawId as number);
  const verdict = args.verdict as string;
  const notes = (args.notes as string) ?? '';

  if (!verdict || !['approved', 'changes-requested', 'escalated'].includes(verdict)) {
    const err = new Error(
      'Invalid verdict. Must be one of: approved, changes-requested, escalated'
    ) as Error & { code: string };
    err.code = 'BAD_REQUEST';
    throw err;
  }

  missionService.setReviewVerdict(id, verdict, notes);
  missionService.setStatus(id, verdict);
  this.emit('state-change', 'mission:changed', { id });
  return missionService.getMission(id);
}
```

- [ ] **Step 2: Add CLI mapping in fleet-cli.ts**

In the `COMMAND_MAP` object, add:

```typescript
'missions.verdict': 'mission.verdict',
```

- [ ] **Step 3: Add CLI validation in fleet-cli.ts**

In the `validateCommand()` function's switch statement, add a case:

```typescript
case 'mission.verdict':
  if (!args.id && !args.missionId)
    return 'Error: missions verdict requires a mission ID.\n\nUsage: fleet missions verdict <mission-id> --verdict <approved|changes-requested|escalated> --notes "..."';
  if (!args.verdict)
    return 'Error: missions verdict requires --verdict flag.\n\nUsage: fleet missions verdict <mission-id> --verdict <approved|changes-requested|escalated>';
  return null;
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add src/main/socket-server.ts src/main/fleet-cli.ts
git commit -m "feat(starbase): add fleet missions verdict CLI command"
```

---

### Task 8: UI — Add status color mappings

**Files:**
- Modify: `src/renderer/src/components/star-command/CrewPanel.tsx:289-293`

- [ ] **Step 1: Add new status colors**

In the `statusColor` object at line 289, add the new statuses:

```typescript
const statusColor: Record<string, string> = {
  queued: 'text-yellow-400',
  active: 'text-green-400',
  done: 'text-neutral-500',
  reviewing: 'text-blue-400',
  approved: 'text-green-400',
  'changes-requested': 'text-yellow-400',
  escalated: 'text-red-400',
  'pending-review': 'text-blue-300',
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/star-command/CrewPanel.tsx
git commit -m "feat(ui): add status color mappings for PR review statuses"
```

---

### Task 9: Integration Verification

- [ ] **Step 1: Full build check**

Run: `npm run build`
Expected: Clean build, no TypeScript errors

- [ ] **Step 2: Verify the review flow conceptually**

Trace the flow manually through the code:
1. Hull `createPR()` now always sets `pending-review` and `pr_branch`
2. Sentinel `reviewSweep()` picks up `pending-review` missions
3. Transitions to `reviewing`, deploys review crew with `type: 'review'` and `prBranch`
4. Review crew's Hull `cleanup()` hits the review path (no changes), parses verdict
5. If `APPROVE` → mission status `approved`, Admiral merges manually
6. If `REQUEST_CHANGES` → `changes-requested`, `review_round` incremented
7. Next Sentinel sweep picks up `changes-requested`, deploys fix crew on same `prBranch`
8. Fix crew pushes to existing PR → Hull detects existing PR → sets `pending-review`
9. Round 2 review
10. If still failing after round 2 → `escalated`, memo to Admiral

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(starbase): complete First Officer automated PR review system"
```
