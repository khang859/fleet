# Repair Mission Type & PR Monitor Design

**Date:** 2026-03-22
**Status:** Approved

---

## Problem

When a code crew completes and creates a PR, two scenarios can leave it stranded:

1. **CI failures** — GitHub CI checks fail after the crew pushes. The mission is `approved` (FO reviewed it), but CI is red.
2. **Human review comments** — A teammate leaves `REQUEST_CHANGES` on the PR after the FO approved.

Manually deploying a new crew to fix these fails with:

```
fatal: 'branchName' is already checked out at '/old/worktree/path'
```

**Root cause:** Hull's cleanup silently swallows `git worktree remove` failures, leaving stale metadata in `.git/worktrees/`. When `createForExistingBranch` tries `git worktree add` on the same branch, git rejects it.

---

## Solution Overview

Three coordinated changes:

1. **`git worktree prune` fix** — prevent the "already checked out" error in `createForExistingBranch`
2. **`repair` mission type** — first-class mission type for fixing issues on an existing PR branch
3. **`prMonitorSweep()`** — Sentinel sweep that detects CI failures and automatically dispatches repair crews

Human review comments that arrive **before** the FO review crew runs are handled by the review crew itself (it reads `gh pr view --comments`). Comments that arrive **after** `approved` are addressed by the Admiral manually dispatching a repair crew — no polling needed for that case.

---

## 1. `git worktree prune` Fix

**File:** `src/main/starbase/worktree-manager.ts` — `createForExistingBranch()`

Add `git worktree prune` before `git worktree add`. Wrap in try/catch — a prune failure is non-fatal and should not block worktree creation:

```typescript
// Prune stale worktree metadata before checkout.
// Prevents "fatal: already checked out at /old/path" when the previous
// crew's worktree removal failed silently and left a stale .git/worktrees/ entry.
// Non-fatal: if prune fails (e.g. permission issue), proceed anyway.
try {
  await execAsync('git worktree prune', execOpts);
} catch {
  // non-fatal — log but continue
}
await execAsync(`git worktree add "${worktreePath}" "${existingBranch}"`, execOpts);
```

**Scope note:** This runs on every `createForExistingBranch` call, including existing review/fix crew deployments. This is intentional — the operation is idempotent and safe.

---

## 2. `repair` Mission Type

A first-class mission type alongside `code`, `research`, `review`, and `architect`.

### Mission type matrix

| Type        | Produces        | Creates PR?                | Requires `prBranch` |
| ----------- | --------------- | -------------------------- | ------------------- |
| `code`      | git commits     | yes (new PR)               | no                  |
| `research`  | cargo/findings  | no                         | no                  |
| `review`    | verdict         | no                         | no                  |
| `architect` | blueprint cargo | no                         | no                  |
| `repair`    | git commits     | no (pushes to existing PR) | yes                 |

### Two mission rows

A repair always involves **two mission rows**:

- **Original code mission** — the mission that produced the PR. Its status is managed by the repair lifecycle (`approved` → `repairing` → `pending-review`).
- **Repair mission** — the new `type: 'repair'` row that the repair crew executes. Goes through normal lifecycle (`queued` → `active` → `completed`/`failed`).

The repair mission stores `originalMissionId` (new field) so Hull can update the original code mission's status on completion.

### Schema addition

```sql
ALTER TABLE missions ADD COLUMN original_mission_id INTEGER REFERENCES missions(id);
```

Populated when creating a repair mission. `NULL` for all other mission types.

### `HullOpts` addition

```typescript
/** For repair missions: the original code mission whose PR this crew is fixing */
originalMissionId?: number;
```

Hull uses this in cleanup to transition the original code mission to `pending-review` after the repair crew pushes.

### Hull repair preamble

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

### `deployCrew` changes

```typescript
// Guard: repair missions require prBranch
if (missionType === 'repair' && !opts.prBranch) {
  throw new Error(`Repair mission ${missionId} requires a prBranch to be set.`);
}
```

`allowedTools` default: `repair` falls through to `undefined` (all tools), same as `code`. No additional entry needed in the defaults chain — this is correct behavior.

Dependency installation: `repair` is NOT added to the skip list (only `review` and `architect` skip install). Repair crews make code changes and need deps installed — they fall through to the install branch by default.

### Hull `createPR` behaviour for repair missions

The existing `gh pr view "${worktreeBranch}"` check at `createPR()` already detects an existing PR and returns early. **However**, it currently sets `pending-review` on `this.opts.missionId` — the repair mission's ID, not the original code mission.

For repair missions, this block must be updated to:

```typescript
if (this.opts.missionType === 'repair') {
  // Push succeeded — update the ORIGINAL code mission to pending-review
  // so the review crew is dispatched for a fresh quality check
  if (this.opts.originalMissionId != null) {
    db.prepare("UPDATE missions SET status = 'pending-review', crew_id = NULL WHERE id = ?").run(
      this.opts.originalMissionId
    );
  }
  // Mark the repair mission itself as completed
  db.prepare(
    "UPDATE missions SET status = 'completed', result = 'Repair complete', completed_at = datetime('now') WHERE id = ?"
  ).run(missionId);
  return;
}
```

This replaces the generic existing-PR early return for repair crews only.

### Hull `cleanup` — no-changes case for repair missions

If a repair crew exits with no git changes (e.g., CI was a transient flake that resolved itself), the current code path marks the mission `failed` ("No work produced"). For `repair`, this should be treated as success — CI may have cleared on its own.

Add to the `!hasChanges` block:

```typescript
if (this.opts.missionType === 'repair') {
  // No changes is acceptable — CI may have resolved itself
  overrideStatus = 'complete';
  db.prepare(
    "UPDATE missions SET status = 'completed', result = 'No changes needed', completed_at = datetime('now') WHERE id = ?"
  ).run(missionId);
  if (this.opts.originalMissionId != null) {
    db.prepare("UPDATE missions SET status = 'pending-review', crew_id = NULL WHERE id = ?").run(
      this.opts.originalMissionId
    );
  }
  return;
}
```

### Hull timeout handling for repair missions

If a repair crew times out, the original code mission would be stuck as `repairing` indefinitely. Add to Hull's timeout/error path:

```typescript
if (this.opts.missionType === 'repair' && this.opts.originalMissionId != null) {
  // Revert original mission to ci-failed so prMonitorSweep can retry
  db.prepare("UPDATE missions SET status = 'ci-failed' WHERE id = ? AND status = 'repairing'").run(
    this.opts.originalMissionId
  );
}
```

### Admiral CLI

```bash
# Create a repair mission targeting an existing PR branch
fleet missions add \
  --sector <id> \
  --type repair \
  --summary "Fix CI failures on auth PR" \
  --prompt "CI is failing on the rate-limit test. Output: ..." \
  --pr-branch <branch-name>

# Deploy the repair crew
fleet crew deploy --sector <id> --mission <mission-id>
```

Confirm `--pr-branch` flag exists on the `fleet missions add` CLI subcommand (check `src/cli/commands/missions.ts`). If not, add it.

### Review crew preamble enhancement

Update the review preamble to include PR comment and CI context:

```
## Additional Review Context
- Run `gh pr view --comments` to see any human reviewer feedback on this PR
- Run `gh pr checks` to see current CI status
- If CI is failing, include that in your REQUEST_CHANGES verdict with the failure details
- If a human reviewer has left REQUEST_CHANGES, incorporate their feedback in your notes
```

---

## 3. `prMonitorSweep()` in Sentinel

### New mission statuses (on the original code mission)

| Status      | Meaning                                                 |
| ----------- | ------------------------------------------------------- |
| `ci-failed` | CI failure detected on PR, repair crew not yet deployed |
| `repairing` | Repair crew actively working — atomic deployment guard  |

### Sweep query

Watches original code missions where:

- `pr_branch IS NOT NULL`
- `status = 'approved'` — only post-FO-approval missions

**Not** `pending-review` — those are already being processed by `reviewSweep`. Mixing the two creates conflicting claim attempts.

```sql
SELECT * FROM missions
WHERE pr_branch IS NOT NULL
  AND status IN ('approved', 'ci-failed')
  AND type = 'code'
```

### Sweep logic

Runs on a **5-minute timer** (separate from the main Sentinel sweep loop) to keep GitHub API usage negligible.

For each mission returned:

**Step 1 — Check CI:**

```bash
gh pr checks <pr_branch> --json name,state,conclusion,required
```

Parse result: if any check with `required: true` has `conclusion: failure` → proceed.

**Step 2 — Get failure details:**

```bash
gh run list --branch <pr_branch> --json databaseId,headSha --limit 5
# Use the run matching the branch's HEAD SHA for reliability
gh run view <run-id> --log-failed
```

Filter by the branch's HEAD SHA (`git rev-parse <pr_branch>`) to avoid picking up runs from earlier commits.

**Step 3 — Atomic claim:**

```sql
UPDATE missions SET status = 'repairing'
WHERE id = ? AND status IN ('approved', 'ci-failed')
```

If `changes === 0` → another process already claimed it. Skip.

**Step 4 — Create repair mission:**

```typescript
const repairMission = missionService.addMission({
  sectorId: original.sector_id,
  type: 'repair',
  summary: `Fix CI failures: ${original.summary}`,
  prompt: buildRepairPrompt(original, ciFailureOutput),
  prBranch: original.pr_branch,
  originalMissionId: original.id // new field
});
```

**Step 5 — Deploy:**

```typescript
try {
  await crewService.deployCrew({
    sectorId: original.sector_id,
    missionId: repairMission.id,
    prompt: repairMission.prompt,
    prBranch: original.pr_branch,
    type: 'repair'
  });
} catch (err) {
  // Rollback: revert original mission so the next sweep can retry
  db.prepare("UPDATE missions SET status = 'ci-failed' WHERE id = ? AND status = 'repairing'").run(
    original.id
  );
  // Delete the orphaned repair mission
  db.prepare('DELETE FROM missions WHERE id = ?').run(repairMission.id);
  throw err;
}
```

**Step 6 — On repair crew completion:**
Hull sets original mission → `pending-review`, repair mission → `completed`.
`reviewSweep` picks up `pending-review` and dispatches a fresh review crew.

### Max repair rounds guard

Reuses the existing `review_round` counter on the original code mission. Before Step 3:

```typescript
if (original.review_round >= MAX_REPAIR_ROUNDS) {
  db.prepare("UPDATE missions SET status = 'escalated' WHERE id = ?").run(original.id);
  // Send escalation memo to Admiral
  commsService.send({
    from: 'first-officer',
    to: 'admiral',
    type: 'memo',
    payload: JSON.stringify({
      missionId: original.id,
      eventType: 'repair-escalation',
      summary: `Mission #${original.id} has failed CI ${MAX_REPAIR_ROUNDS} times after repair attempts`
    })
  });
  return;
}
```

`MAX_REPAIR_ROUNDS` default: `2` (matches existing review round limit). Configurable via `starbase_config`.

Increment `review_round` on the original mission when a repair crew is deployed (Step 3, after atomic claim):

```sql
UPDATE missions SET review_round = review_round + 1 WHERE id = ?
```

### `buildRepairPrompt` function

New utility function in `hull.ts` or a shared `repair-utils.ts`:

```typescript
function buildRepairPrompt(original: MissionRow, ciOutput: string): string {
  return [
    original.prompt,
    '',
    '---',
    '',
    '## Repair Context',
    '',
    `**Reason:** CI failure detected on PR branch \`${original.pr_branch}\``,
    `**Repair round:** ${original.review_round + 1}`,
    '',
    '## CI Failure Output',
    '',
    ciOutput.slice(0, 4000),
    '',
    'Push your fixes to the current branch — the PR already exists and will be updated automatically.',
    'Do NOT create a new PR.'
  ].join('\n');
}
```

### `SentinelDeps` addition

```typescript
type SentinelDeps = {
  // ... existing fields ...
  missionService: MissionService; // ADD — needed for prMonitorSweep to create repair missions
};
```

### `gh` availability guard

```typescript
if (!Hull.isGhAvailable()) {
  // Log once, skip sweep entirely
  return;
}
```

---

## 4. Post-Approval Human Review (Manual Escape Hatch)

For human `REQUEST_CHANGES` comments that arrive after the FO has set the mission to `approved`, the Admiral handles this manually:

```bash
fleet missions add --sector <id> --type repair \
  --summary "Address review comments on auth PR" \
  --prompt "Reviewer @alice requested: ..." \
  --pr-branch <branch>

fleet crew deploy --sector <id> --mission <mission-id>
```

The Admiral must also manually set the original mission to `repairing` before deploying (or the UI provides a "Deploy Repair Crew" action that does this atomically). This prevents `prMonitorSweep` from also detecting a CI failure and deploying a second repair crew simultaneously.

---

## 5. Status Flow

```
[Code crew completes, PR created]
        ↓
   pending-review
        ↓
  reviewSweep dispatches review crew
  (review crew: gh pr checks + gh pr view --comments)
        ↓
   approved
        ↓  (every 5 min)
  prMonitorSweep: gh pr checks → CI failure?
        ↓ yes
   [atomic] approved → repairing
        ↓
  repair mission created, repair crew deployed
  (createForExistingBranch with git worktree prune)
        ↓
  repair crew pushes fixes to existing PR branch
        ↓
  Hull: repair mission → completed
        original mission → pending-review
        ↓
  reviewSweep dispatches review crew (round N+1)
        ↓
   approved ──────────────────────────────────────────┐
        │                                              │
        │ (if CI fails again and review_round < 2)    │
        └──────────────────────────────────────────── ┘
        │
        │ (if review_round >= 2 or review crew escalates)
        ↓
   escalated → memo to Admiral
```

---

## Files to Change

| File                                       | Change                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/starbase/worktree-manager.ts`    | Add `git worktree prune` (in try/catch) before `git worktree add` in `createForExistingBranch`                                                  |
| `src/main/starbase/hull.ts`                | Add `repairPreamble`; add `originalMissionId` to `HullOpts`; update `createPR` repair path; add no-changes and timeout handling for repair type |
| `src/main/starbase/crew-service.ts`        | Add `repair` guard (require `prBranch`); pass `originalMissionId` through to Hull                                                               |
| `src/main/starbase/sentinel.ts`            | Add `prMonitorSweep()` on 5-min timer; add `missionService` to `SentinelDeps`                                                                   |
| `src/main/starbase/mission-service.ts`     | Add `originalMissionId` to `AddMissionOpts` and `INSERT`                                                                                        |
| `src/main/starbase/migrations.ts`          | Add `original_mission_id` column to `missions` table                                                                                            |
| `src/main/starbase/workspace-templates.ts` | Add `repair` to mission type lists and env var docs in both `generateClaudeMd()` and `generateSkillMd()`; add repair workflow section           |
| `src/main/fleet-cli.ts`                    | Add `repair` to valid types in `mission.create` handler; add `--pr-branch` and `--original-mission-id` flags; update help text                  |
