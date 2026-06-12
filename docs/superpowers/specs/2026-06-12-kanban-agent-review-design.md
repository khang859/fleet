# Kanban Agent Code Review

**Date:** 2026-06-12
**Status:** Approved design
**Issue:** #232 (autonomous-team). Depends on: #231 (deterministic verify gates).

## Problem

No automated code review exists. A finished worktree task lands in the `review`
column showing a raw diff for a human to eyeball, and a human clicks "Merge to
base." The only review-like agent is the swarm verifier, which applies only to
swarms.

For the autopilot's feature tasks (auto-merged by `integrate()`), there is *no*
per-task quality gate at all beyond the optional verify commands (#231) — the
human reviews once at the feature PR, after every member task has already merged
into the integration branch. A bad change is caught late.

This spec adds an agent code-review stage: a reviewer LLM run on a completed
task's diff that records a structured verdict (approve / request changes with
findings) before the task reaches the review column or is auto-merged.
Request-changes bounces the task back to the worker with the findings; a bounded
loop converges or soft-escalates to a human.

## Goals

- Every worktree completion gets an agent review verdict recorded on the task
  before merge/review (when `autoReview` is on).
- Request-changes findings flow back to the original worker as comments; the
  task is re-worked and re-reviewed; the loop converges or escalates to a human.
- For feature tasks, the agent verdict gates `integrate()`'s auto-merge — the
  per-task human click is replaced; the human still reviews once at the feature
  PR.
- One global toggle (`autoReview`) turns the whole stage off, restoring exactly
  today's (pre-#232) behavior.

## Non-goals

- Auto-merging anything new (feature auto-merge is #228; this only *gates* it).
- Multiple reviewer profiles or per-task reviewer selection.
- Severity taxonomies, line numbers, or suggested-patch fields in findings.
- Inline file/line review annotations in the UI.
- Re-reviewing `resolve`-mode (merge-conflict) output (known v1 gap; section 9).
- Reviewing swarm-internal tasks (they already carry their own verifier card).

## Architecture

Agent review is a new agent **run mode** (`'review'`) on the task's existing
worktree, spawned by a new dispatcher stage, gated by a new global `autoReview`
setting (default **on**). It reuses the established orchestrator-run machinery
(claim via a CAS `claimForReview`, lease, heartbeat, reclaim) exactly as
`resolve` and `suggest` do.

It slots into the post-completion chain established by the verify gate (#231):

```
kanban_complete (worktree)
  → finalizeWorktree (commit)
  → [verify gate #231, if the project has verifyCommands]
  → task lands in `review` status, review_verdict = NULL
  → reviewTasks() dispatcher stage claims it (status → running, mode 'review')
  → reviewer agent runs on the worktree, calls kanban_review_verdict(...)
  → reclaim() review branch routes on the recorded verdict:
       approve          → status `review`, verdict=approve, HEAD SHA recorded
                          → integrate()/human merge proceed
       request_changes  → under cap: spawnReviewFix (fresh `work` run with the
                          findings injected) — re-enters the FULL chain
                          (verify again, then review again)
       request_changes  → at cap, OR inconclusive (agent ended turn without
       / inconclusive     calling the tool): soft-escalate — status `review`,
                          findings attached, fire the human review-ready
                          notification. verdict stays non-approve so integrate()
                          skips it; the human merge click is the override.
```

Single spawn site (`reviewTasks()`), single outcome handler (a new `reclaim()`
branch mirroring the verify branch). The task transiently re-enters `running`
while under review, exactly as `resolve`/`suggest` reclaim a `review`-status
task.

### Tick placement

```
Dispatcher tick:
  1. reclaim                      (existing; gains a 'review' branch)
  2. fireSchedules                (existing)
  3. decompose                    (existing)
  4. autoAssign                   (existing)
  5. detectFeatureGroups          (existing)
  6. promote                      (existing)
  7. claimAndSpawn                (existing)
  8. reviewTasks                  (NEW) — claim review-status tasks, spawn review runs
  9. integrate                    (existing; gains an approve-verdict guard)
  10. sweepArtifacts / worktrees  (existing)
```

`reviewTasks()` runs **before** `integrate()` so a feature task pending review is
claimed (status → running) and therefore invisible to `integrate()` that same
tick; `integrate()` additionally guards on `review_verdict='approve'` for any
review-status feature task it does see.

## 1. `reviewTasks()` dispatcher stage

Gated on the new global `autoReview` setting (default **on**).

For each task that is `status='review'`, `workspaceKind='worktree'`,
`review_verdict IS NULL`, `systemKind IS NULL` (not a system/sync task), not a
member of a swarm graph (section 9), and has no review run already in flight:

1. `claimForReview(taskId, lock, ttl)` — CAS on `status='review'`; sets the
   claim lock, flips status to `running`. Skip on lost race.
2. `startRun(taskId, 'reviewer', null, 'review')`.
3. `spawnWorker({ task, runId, lock, workspace: task.workspacePath, mode: 'review' })`.
4. `setWorkerPid`, append `spawned` event with `mode: 'review'`.
5. On spawn failure: `recordFailure`, `finishRun('spawn_failed')`, append
   `spawn_failed`, `setStatusCleared(taskId, 'review')` (hand back so a later
   tick retries), log. Never throws out of the tick.

Bounded per tick by `MAX_REVIEW_PER_TICK = 3` (matches `MAX_INTEGRATE_PER_TICK`).
`orchestratorRunningCount()` must **exclude** `'review'` runs (they are not
triage orchestrator runs), exactly as it already excludes `'verify'`.

## 2. `review` run mode

New `RunMode` value `'review'`, spawned via the existing worker machinery.

- **Workspace:** the task's existing worktree (read-only intent; the reviewer
  does not modify the tree).
- **Tools:** `kanban_show`, `kanban_comment`, `kanban_heartbeat`, and the
  terminal `kanban_review_verdict` (section 3). `requireToolsForMode` gains a
  `'review'` case returning this set.
- **Prompt** (`buildWorkerInput`, new `review` block): the reviewer persona
  (section 4) + the task title/body/acceptance criteria + the worktree diff vs
  its base branch. The diff is byte-capped (reuse the verify-tail cap); on
  overflow, truncate and append a reference to the full diff written to a log
  path (mirrors the verify failure tail + log-ref pattern).
- **No** `kanban_complete`/`kanban_block`: the reviewer is not completing the
  work, only judging it.

## 3. `kanban_review_verdict` terminal tool

New terminal MCP tool, available only in `review` mode. Mirrors how
`kanban_assign` / `kanban_suggest_feature` are terminal tools for orchestrator
runs.

```ts
kanban_review_verdict(
  decision: 'approve' | 'request_changes',
  summary: string,
  findings?: Array<{ file?: string; note: string }>
)
```

Behavior:

- Validate `decision` (zod enum; reject other values), `summary` (non-empty
  string), `findings` (optional array; each `note` required, `file` optional).
- Record the verdict on the task: set `review_verdict = decision`. On `approve`,
  also capture `review_head_sha` = the worktree's current HEAD SHA.
- Persist the findings as a task comment (author `reviewer`) and append a
  `review_passed` (approve) or `review_changes_requested` (request_changes)
  event carrying `{ summary, findings }`.
- `finishRun(runId, 'completed', { summary })`; unregister the run; end the
  process.
- The task stays in `running` until `reclaim()` routes it next tick (section 5).

The tool only *records*; the dispatcher's `reclaim()` performs the status
transition and any bounce spawn (spawning lives in the dispatcher, consistent
with verify).

## 4. Reviewer profile (singleton)

- `WorkerProfile.role` gains `'reviewer'`: `'worker' | 'orchestrator' | 'reviewer'`.
- Exactly one reviewer profile, reserved name `reviewer`
  (`REVIEWER_PROFILE_NAME`), mirroring the orchestrator singleton
  (`ORCHESTRATOR_PROFILE_NAME`). Seeded with a default critic persona
  (`DEFAULT_REVIEWER_INSTRUCTIONS`) in `src/shared/types.ts` where both main
  (seed) and renderer (Settings "Reset to default") reach it.
- Surfaced in Settings alongside the orchestrator: editable persona/model,
  "Reset to default" button. No assignment UI — the reviewer is never assigned
  to a task; the stage always uses the singleton.
- Default persona: a senior-reviewer critic — judge the diff against the task's
  acceptance criteria; approve when the change is correct, focused, and matches
  the spec; request changes with specific, actionable findings otherwise; do not
  nitpick style the verify commands already enforce.

## 5. `reclaim()` review branch

Placed alongside the existing `suggest` / `verify` reclaim branches (before the
generic exit-3 / blockNow branches). Applies when the reclaimed run's mode is
`'review'`:

Read the verdict the terminal tool recorded on the task:

- **`approve`** → `setStatusCleared(task.id, 'review')` keeping
  `review_verdict='approve'` and `review_head_sha` (the work summary is already
  persisted; don't overwrite it); `resetReviewAttempts`;
  append `review_passed`; fire the human review-ready notification (section 7).
  `integrate()` / human merge proceed next tick.
- **`request_changes`** →
  - If `review_attempts < REVIEW_ATTEMPT_CAP` (cap = 2, pre-increment check like
    `spawnResolve`/`spawnVerifyFix`): `spawnReviewFix(task, findings)` — a fresh
    `work` run on the same worktree with the findings injected via the prompt
    (NOT as a comment-only nudge); `incrementReviewAttempts`. The fix run, on
    completion, re-enters the full chain (verify, then review again).
  - Else (at cap): soft-escalate — `setStatusCleared(task.id, 'review')` with
    `review_verdict='request_changes'` retained, append `review_escalated`
    (`{ reason: 'request_changes cap reached', findings }`), add a comment, fire
    the review-ready notification. `integrate()` skips it (verdict ≠ approve);
    the human merge click is the override.
- **inconclusive** (run ended terminally — exit, dead pid, or expired claim —
  with no verdict recorded): soft-escalate exactly as the cap case, append
  `review_escalated` (`{ reason: 'reviewer returned no verdict' }`). Never
  auto-approve.

A fresh `work` run starting on the task (claimAndSpawn, verify-fix, or
review-fix) clears `review_verdict` and `review_head_sha` to NULL — the diff has
changed, so any prior approval is stale and the task must be re-reviewed.

## 6. `integrate()` change

One guard added to the existing feature-task integrate path: a review-status
feature task is eligible to auto-merge only when agent review has approved it.

```ts
// inside integrateTasks(), per candidate task:
if (this.deps.config.autoReview && task.reviewVerdict !== 'approve') continue;
```

This single check skips both not-yet-reviewed (verdict NULL) and
request-changes / escalated (verdict 'request_changes') tasks. When `autoReview`
is off, the guard is inert and `integrate()` behaves exactly as today
(verify-gated or ungated, per #231/#228).

**Stale-diff assertion:** before merging an approved task, assert the worktree
HEAD equals `review_head_sha`. On mismatch (some later run touched the tree),
clear `review_verdict`/`review_head_sha` to NULL and skip — `reviewTasks()`
re-reviews it next tick. Cheap insurance that `integrate()` merges exactly what
was approved.

## 7. Notifications

The human "ready for review" notification must fire **once**, on the agent
verdict, not when the task first enters `review` — otherwise `autoReview`
double-notifies (gate-pass *and* verdict).

- When `autoReview` is **on**: suppress the review-ready notification on the
  gate-pass events (`verify_passed` / the ungated completion). Fire it instead
  on `review_passed` and `review_escalated`.
- When `autoReview` is **off**: gate-pass events notify exactly as today; no
  review events are produced.

`classifyKanbanEvent` mappings:

| Event kind | Category | Notes |
|---|---|---|
| `review_passed` | `completed` | approve → task ready for merge/review |
| `review_escalated` | `completed` | cap/inconclusive → human attention needed |
| `review_changes_requested` | `null` | in-flight bounce; silent (like `verify_failed`) |
| `review_started` | `null` | informational; silent |

Implementation note: gate-pass suppression is conditioned on `autoReview` so the
classify table stays static; the notifier consults the setting to decide whether
the gate-pass `completed` event reaches a channel. (Alternatively, the
dispatcher emits the gate-pass event with a payload flag the notifier honors —
the plan picks the simpler of the two.)

## 8. Settings & guardrails

| Setting | Default | Effect |
|---|---|---|
| `autoReview` | on | enables the `reviewTasks()` stage and the `integrate()` approve-guard |

Hard guardrails, not configurable:

- `review_attempts` capped at `REVIEW_ATTEMPT_CAP = 2` → soft-escalate to human
  review (never `blocked`; the task *can* proceed, a human just decides).
- The reviewer never modifies the worktree (no completion/block tools).
- Approved tasks merge only at their recorded HEAD SHA (section 6).
- All review runs best-effort: spawn/agent failures fail open to human review
  with an event/comment; never throw out of the tick.
- Every action appends a task event, preserving the audit trail.

## 9. Data model changes (migration 15)

- `tasks.review_verdict` (TEXT, `'approve' | 'request_changes' | NULL`).
- `tasks.review_attempts` (INTEGER, NOT NULL DEFAULT 0).
- `tasks.review_head_sha` (TEXT, NULL until approved).
- `RunMode` gains `'review'`; `WorkerProfile.role` gains `'reviewer'`.
- New `KanbanSettings.dispatcher.autoReview` (boolean).
- Additive migration via the existing `addColumnIfMissing` pattern; bump
  `SCHEMA_VERSION` 14 → 15. **Any SCHEMA_VERSION bump must run the full
  `kanban-store.test.ts` suite** (see
  `docs/learnings/2026-06-12-schema-bump-breaks-store-suite.md`).

**Swarm exemption.** `reviewTasks()` skips tasks that belong to a swarm graph
(they already get a dedicated agent verifier card via `verifierAssignee`). There
is no single swarm-membership column: members are connected through `task_links`
up to a swarm **root**, identifiable by its blackboard metadata
`kind === 'kanban_swarm_v1'` (`SWARM_ROOT_KIND`, `kanban-swarm.ts`). The
candidate query excludes any task whose `task_links` ancestry reaches such a
root — add a store predicate `isSwarmMember(taskId)` (walk `task_links` parents
to a `kanban_swarm_v1` root) and exclude it in `reviewPendingTasks()`.

**Store methods to add** (mirroring resolve/verify equivalents):
`claimForReview`, `setReviewVerdict(taskId, decision, headSha?)`,
`incrementReviewAttempts`, `resetReviewAttempts`, `clearReviewVerdict`, and a
candidate query `reviewPendingTasks()`.

## 10. UI

- Card/drawer badge for the review run (e.g. "reviewing — attempt 1/2") and the
  verdict state ("changes requested", "approved"), driven by run mode + the
  `review_*` events already streamed to the board (mirrors the resolve/verify
  badges).
- Findings appear in the task comment/event thread (terminal tool writes a
  `reviewer` comment).
- Settings: the singleton reviewer profile editor (persona + model + "Reset to
  default"), alongside the orchestrator.

## 11. Testing

Vitest unit tests, mirroring the verify-gate suite style (mocked store deps /
spawn fns):

- `reviewTasks()`: claims a review-status worktree task with NULL verdict →
  spawns a `review` run; skips swarm tasks, system tasks, non-worktree tasks,
  tasks already verdicted, and tasks with a review run in flight; per-tick cap
  honored; `autoReview` off → no-op; spawn failure → back to `review`, no throw.
- `reclaim()` review branch: `approve` → status `review` + verdict + HEAD SHA +
  `resetReviewAttempts` + `review_passed`; `request_changes` under cap →
  `spawnReviewFix` (fresh `work` run, findings injected) + increment; at cap →
  soft-escalate (`review` + verdict retained + `review_escalated` + notify);
  inconclusive (no verdict) → soft-escalate.
- `integrate()` guard: `autoReview` on + verdict ≠ approve → skipped; verdict =
  approve → merges; HEAD-SHA drift → verdict cleared + re-review; `autoReview`
  off → behaves as #228/#231.
- `kanban_review_verdict`: approve records verdict + HEAD SHA + comment + event;
  request_changes records findings + event; rejects an invalid `decision`;
  rejects empty `summary`.
- Fresh `work` run clears `review_verdict`/`review_head_sha`.
- Notifications: `review_passed` / `review_escalated` → `completed`;
  `review_changes_requested` / `review_started` → null; gate-pass review-ready
  notification suppressed when `autoReview` on, present when off.

## 12. Implementation phasing

One plan, TDD task order:

1. Types + schema migration 15 (`review_verdict`, `review_attempts`,
   `review_head_sha`, `RunMode 'review'`, `role 'reviewer'`, `autoReview`
   setting) + full store suite.
2. Store methods (`claimForReview`, verdict/attempt mutators, candidate query,
   `orchestratorRunningCount` excludes `review`).
3. Reviewer profile singleton + default persona + `requireToolsForMode` case +
   `buildWorkerInput` review prompt block.
4. `kanban_review_verdict` terminal tool (MCP server).
5. `reviewTasks()` dispatcher stage.
6. `reclaim()` review branch + `spawnReviewFix` + fresh-work-clears-verdict.
7. `integrate()` approve-guard + HEAD-SHA assertion.
8. Notifications (classify table + gate-pass suppression).
9. UI badges + Settings reviewer editor.
