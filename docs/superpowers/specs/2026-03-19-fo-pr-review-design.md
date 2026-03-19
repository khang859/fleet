# First Officer Automated PR Review

**Date:** 2026-03-19
**Status:** Approved

## Summary

Automate PR code review for completed code missions. When a crew finishes a coding mission and creates a PR, the First Officer (via Sentinel) dispatches a review crew to evaluate the PR in its own worktree. If changes are needed, a fix crew is deployed on the same branch. After 2 failed review rounds, the FO escalates to the Admiral via memo. FO never merges — it only approves. The Admiral/Commander decides what to merge.

## Mission Status Flow

```
queued → active → [crew completes, PR created] → pending-review
    → reviewing        (Sentinel dispatches review crew)
    → approved         (review passed — Admiral/Commander merges manually)
    → changes-requested (review crew found issues)
        → active       (fix crew deployed on same PR branch)
        → pending-review (fix crew pushes to same PR)
        → reviewing    (round 2)
        → approved | escalated
    → escalated        (max rounds hit or ambiguous — memo to Admiral)
```

### New Statuses

| Status | Meaning |
|---|---|
| `reviewing` | Review crew actively working (prevents Sentinel re-dispatch) |
| `approved` | PR passed review, waiting for human merge decision |
| `changes-requested` | Review crew found issues, fix crew will be deployed |
| `escalated` | FO couldn't resolve after 2 rounds, Admiral intervenes |

### Existing Statuses Reused

- `pending-review` — Sentinel trigger (already exists, set by Hull after PR creation)
- `active` — fix crew working (already exists)

### Trigger Condition

The `pending-review` status is set by Hull for ALL code missions that successfully create a PR, regardless of the sector's `review_mode` setting. The existing `review_mode = 'admiral-review'` gate in Hull is removed — automated FO review replaces manual Admiral review as the default flow. Admiral only gets involved on escalation.

### Legacy Status Reconciliation

The existing `review-rejected` status (referenced in Sentinel's `firstOfficerSweep()` query) is replaced by `changes-requested`. The Sentinel query at line 267 should be updated to use `changes-requested` instead of `review-rejected`.

## Sentinel Integration

### New Sweep Function: `reviewSweep()`

Runs alongside `firstOfficerSweep()` in the Sentinel's sweep loop.

**Watches for:**
- `pending-review` — dispatches a review crew
- `changes-requested` (when `review_round < 2`) — dispatches a fix crew

**On `pending-review`:**
1. Transition mission status to `reviewing`
2. Deploy review crew via `crewService.deployCrew()` with `type: 'review'` and `prBranch`

**On `changes-requested`:**
1. Check `review_round < 2` — if at limit, set status to `escalated` and write memo
2. Deploy fix crew via `crewService.deployCrew()` with `type: 'code'` and `prBranch`
3. Fix crew prompt includes the review notes from the previous round

**Key design decision:** Sentinel calls `crewService.deployCrew()` directly rather than going through FO's Claude subprocess. The FO subprocess pattern (spawn Claude → Claude calls CLI → CLI deploys crew) adds unnecessary indirection for reviews.

### Sweep Ordering

`reviewSweep()` runs BEFORE `firstOfficerSweep()` in `runSweep()`. This ensures review missions are claimed by the review flow before the failure-triage sweep could see them in an intermediate state.

### Concurrency

Separate config key `review_crew_max_concurrent` (default: 2), independent from `first_officer_max_concurrent`. Review dispatches don't compete with failure-triage slots.

### Dedup

The `reviewing` status transition is the guard. Sentinel only queries `pending-review`, so once it flips to `reviewing`, subsequent sweeps skip it. The `changes-requested` status is similarly consumed when a fix crew is deployed (mission goes back to `active`).

## Review Crew Deployment & Hull Behavior

### WorktreeManager

New method `createForExistingBranch(sectorPath, existingBranch)`:
```
git fetch origin <branch>:<branch>
git worktree add <path> <branch>
```
Uses `fetch origin <branch>:<branch>` to create a proper local tracking branch (not detached HEAD), so fix crews can later push commits back to the PR branch.

### CrewService

- `deployCrew()` accepts optional `prBranch?: string`
- When `type === 'review'`, calls `createForExistingBranch()` instead of `create()`
- Skips `installDependencies()` for review crews (read-only — they run tests via verify command)

### Hull Changes for `missionType === 'review'`

Early guard in `cleanup()` before any git push/PR logic:

1. Run sector's `verifyCommand` if present (so review crew validates tests pass)
2. Parse crew output for structured verdict:
   ```
   VERDICT: APPROVE | REQUEST_CHANGES | ESCALATE
   NOTES: <review notes with file:line references>
   ```
3. Call `missionService.setReviewVerdict(missionId, verdict, notes)`
4. Set mission status: `approved`, `changes-requested`, or `escalated`
5. Send `review_verdict` comms transmission to Admiral
6. If `ESCALATE`, write memo via `memoService`
7. Skip all push/PR/rebase logic

**Safety guard:** If a review crew accidentally stages changes, the `missionType === 'review'` check short-circuits `cleanup()` before the push section. Changes are discarded with the worktree.

**Review crew cleanup path:** The early return for review missions happens inside the `try` block (not from `cleanup()` itself), so the `finally` block still runs and removes the worktree as expected.

### HullOpts Additions

- `prBranch?: string` — the existing PR branch to check out
- `baseBranch` — already exists, used by the review prompt for `git diff <baseBranch>...<prBranch>`

### MissionRow Type Updates

Add `review_round: number` and `pr_branch: string | null` to the `MissionRow` TypeScript interface in `mission-service.ts`.

## Fix Crew Flow

When review returns `REQUEST_CHANGES` and `review_round < 2`:

1. Sentinel deploys fix crew with `type: 'code'` on the same `prBranch`
2. Fix crew gets a prompt with original mission context + review feedback
3. Normal Hull `cleanup()` runs — commits, pushes to same branch (same PR updated)
4. Hull detects PR already exists on branch, skips `createPR()`
5. Status transitions back to `pending-review`, `review_round` incremented
6. Sentinel dispatches review crew for round 2

### Fix Crew Prompt

```
Fix the issues identified in the PR review for branch `<prBranch>`.

## Original Mission
Summary: <mission.summary>
Acceptance Criteria: <mission.acceptance_criteria>

## Review Feedback (Round <N>)
<review_notes from previous review>

## Instructions
1. Read the review feedback carefully
2. Address each issue mentioned
3. Run the verify command to ensure tests still pass
4. Commit and push your fixes
```

### Escalation

If `review_round >= 2` and verdict is still `REQUEST_CHANGES`, Sentinel:
- Sets status to `escalated`
- Writes memo to Admiral with: original mission, PR URL, review history from both rounds

### Edge Cases

**Review crew timeout:** If a review crew times out, Hull sets mission status to `escalated` (not `failed`). This prevents the mission from entering the failure-triage loop. A memo is written to Admiral noting the timeout.

**Fix crew failure:** If a fix crew fails or errors (no diff, error exit, timeout), normal FO triage rules apply — `firstOfficerSweep()` picks it up. The review loop does not re-engage until a crew successfully completes and pushes.

**PR branch deleted between rounds:** If `git fetch` fails in `createForExistingBranch()`, the deployment fails and Sentinel sets status to `escalated` with a memo explaining the branch is gone.

### `review_round` Increment

Hull's review cleanup path calls `missionService.incrementReviewRound()` when setting status to `changes-requested`. This ensures the round count is incremented at verdict time, not at fix crew dispatch time.

## Review Crew Prompt & Methodology

### System Prompt

Core review principles (distilled from existing plugin agents):
- **Confidence-based filtering:** Only report issues with >=80% confidence
- **Severity stratification:** CRITICAL (blocks approval), IMPORTANT (should fix), MINOR (don't report)
- **Pragmatic stance:** Strict on modifications to existing code, pragmatic on new isolated code
- **Verify against reality:** Run the sector's verify command, don't just read diffs
- **YAGNI check:** Flag unnecessary complexity, over-engineering, unused abstractions

Review checklist:
1. Acceptance criteria met? Compare PR changes against mission's acceptance criteria
2. Code quality — logic errors, null handling, race conditions, security vulnerabilities
3. Test coverage — meaningful tests present and passing?
4. Conventions — follows existing patterns in the codebase?
5. Simplicity — could this be simpler while still meeting requirements?

### Initial Message (Mission Prompt)

```
Review the PR on branch `<prBranch>` targeting `<baseBranch>`.

## Mission Context
Summary: <mission.summary>
Acceptance Criteria: <mission.acceptance_criteria>

## Instructions
1. Run the verify command to check tests pass
2. Read the diff: `git diff <baseBranch>...<prBranch>`
3. Review against acceptance criteria and code quality
4. Output your verdict in this exact format:

VERDICT: APPROVE | REQUEST_CHANGES | ESCALATE
NOTES: <your review notes — specific file:line references for issues>
```

### Allowed Tools

Restricted to read-only operations — no file writes, no git commits.

## CLI & Socket Commands

### New Command

`fleet missions verdict <mission-id> --verdict <approved|changes-requested|escalated> --notes "..."`

- Socket handler: `mission.verdict`
- Calls `missionService.setReviewVerdict()` and `missionService.setStatus()`
- Allows Admiral/Commander to manually override FO's verdict

### Modified Commands

- `fleet missions list` — displays new statuses in output (no structural change)
- `fleet missions show <id>` — includes `review_verdict`, `review_notes`, `review_round`

## Database Changes

Single migration adding two columns to `missions`:

```sql
ALTER TABLE missions ADD COLUMN review_round INTEGER DEFAULT 0;
ALTER TABLE missions ADD COLUMN pr_branch TEXT;
```

Both additive with defaults — no data migration needed.

`pr_branch` is set by Hull in `createPR()` immediately after successful PR creation, using the `worktreeBranch` from HullOpts:
```sql
UPDATE missions SET pr_branch = ? WHERE id = ?
```
Read by Sentinel when deploying review/fix crews.

## Config Keys

| Key | Default | Description |
|---|---|---|
| `review_crew_max_concurrent` | 2 | Max concurrent review crew dispatches (separate from failure-triage) |

## UI Changes

Minimal — new statuses need color mappings in MissionsPanel:

| Status | Color | Meaning |
|---|---|---|
| `reviewing` | Blue | In progress |
| `approved` | Green | Ready for merge |
| `changes-requested` | Yellow | Fix needed |
| `escalated` | Red | Needs Admiral attention |

Escalation memos appear in MemoPanel automatically. Review verdict transmissions appear in CommsPanel. No new panels or components needed.

## Files to Modify

| File | Changes |
|---|---|
| `sentinel.ts` | Add `reviewSweep()`, call from `runSweep()` |
| `hull.ts` | Add `prBranch` to HullOpts, `'review'` path in `cleanup()`, store `pr_branch` after PR creation |
| `crew-service.ts` | Accept `prBranch`/`type` in deploy opts, conditional worktree creation, skip deps for review |
| `worktree-manager.ts` | Add `createForExistingBranch()` method |
| `mission-service.ts` | Add `incrementReviewRound()`, expose `pr_branch` in queries |
| `socket-server.ts` | Add `mission.verdict` handler |
| `fleet-cli.ts` | Add `missions verdict` command mapping |
| `migrations.ts` | Migration adding `review_round` and `pr_branch` columns |
| MissionsPanel (UI) | Status color mappings for new statuses |
