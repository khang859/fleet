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

**The verify run — not `assign`/`suggest` — is the precedent for this design.**
Verify is a run that *records its outcome* and lets `reclaim()` route the task;
the agent terminal tools (`kanban_assign` → `returnToReady`,
`kanban_suggest_feature` → `deleteTask`, `kanban_complete` → `reviewTask`)
instead transition the task status *inside the MCP handler*, and their
`reclaim()` branches handle only the failure path (run died without the tool
firing). `kanban_review_verdict` deliberately follows the verify model: it
records the verdict and leaves the task in `running`, and the dispatcher routes.
This rests on three invariants the implementation MUST honor (section 5).

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
`workspacePath IS NOT NULL` (the worktree still exists — mirrors
`reviewWorktreeFeatureTasks`), `review_verdict IS NULL`, `systemKind IS NULL`
(not a system/sync task), and not a member of a swarm graph (section 9). The
candidate query (`reviewPendingTasks()`) selects only `review`-status tasks, so
claiming one flips it to `running` and removes it from the next pass — there is
no "review run already in flight" case to filter (a running task is not a
candidate).

1. `claimForReview(taskId, lock, ttl)` — CAS on `status='review'`; sets the
   claim lock, flips status to `running`. Skip on lost race.
2. `startRun(taskId, 'reviewer', null, 'review')`.
3. `spawnWorker({ task, runId, lock, workspace: task.workspacePath, mode: 'review' })`.
4. `setWorkerPid`, append `spawned` event with `mode: 'review'`.
5. On spawn failure: `recordFailure`, `finishRun('spawn_failed')`, append
   `spawn_failed`, log; then **bound the retry loop** — if the task's
   `consecutiveFailures >= config.failureLimit`, soft-escalate (section 5's
   escalate path: `setStatusCleared(taskId, 'review')` with a `review_escalated`
   event + notification) so a persistent spawn failure doesn't bounce
   review→running→review every tick forever; otherwise `setStatusCleared(taskId,
   'review')` to retry next tick. Never throws out of the tick.

Bounded per tick by `MAX_REVIEW_PER_TICK = 3` (matches `MAX_INTEGRATE_PER_TICK`).
`orchestratorRunningCount()` is `mode NOT IN ('work','verify')` today; it must
**also exclude** `'review'` (review runs are not triage orchestrator runs and
must not eat decompose/assign/suggest slots).

## 2. `review` run mode

New `RunMode` value `'review'`, spawned via the existing worker machinery.

- **Workspace:** the task's existing worktree (read-only intent; the reviewer
  does not modify the tree).
- **Tools:** `kanban_show`, `kanban_comment`, `kanban_heartbeat`, and the
  terminal `kanban_review_verdict` (section 3). `requireToolsForMode`
  (module-private in `spawn-worker.ts`) gains a `'review'` case returning this
  set.
- **Prompt** (the `BuildWorkerInput` interface + private `buildPrompt()` in
  `spawn-worker.ts`, new `review` block): the reviewer persona (section 4) + the
  task title/body/acceptance criteria + the worktree diff vs its base branch.
  The diff is **generated** by a new helper (a `git diff <baseBranch>...HEAD` in
  the worktree — `readLogTail` is a tail *consumer*, not a producer, so it is not
  reusable here), byte-capped at the same size as the verify tail; on overflow,
  truncate and append a reference to the full diff written to a deterministic log
  path (a `verifyLogPath`-style `reviewDiffPath(runId)` injected dep). `findings`
  from a prior `request_changes` bounce reach the *work* run via its own prompt
  field (section 5 / §4.1 `index.ts` wiring), not this review prompt.
- **No** `kanban_complete`/`kanban_block`: the reviewer is not completing the
  work, only judging it.

## 3. `kanban_review_verdict` terminal tool

New terminal MCP tool, available only in `review` mode. It follows the **verify**
pattern (record-only), NOT the `kanban_assign`/`kanban_suggest_feature` pattern
(those transition status in the handler).

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
- **CAS guard (S1):** record only if `scope.runId === task.currentRunId &&
  task.status === 'running'`. A reviewer process reclaimed-but-still-alive must
  not write a verdict onto a task that has since escalated or begun a new cycle
  (this write gates auto-merge, so the looseness `kanban_complete` tolerates is
  unacceptable here). If the guard fails, no-op and end.
- Record the verdict on the task: `setReviewVerdict(taskId, decision, headSha?)`
  — set `review_verdict = decision`; on `approve`, also capture
  `review_head_sha` = the worktree's current HEAD SHA.
- Persist the findings as a task comment authored `reviewer` (the handler's
  default `author = task.assignee ?? 'worker'` must be made mode-aware so a
  review-mode scope authors as `reviewer` — see §4.1) and append
  a `review_passed` (approve) or `review_changes_requested` (request_changes)
  event carrying `{ summary, findings }`.
- `finishRun(runId, 'completed', { summary })`; unregister the run; end the
  process.

**Invariant (B1):** `setReviewVerdict` and `finishRun` must NOT clear
`tasks.current_run_id` (none of the `set*`/`finishRun` paths do; only
`completeTask`/`reviewTask`/`blockTask`/`returnToReady`/`setStatusCleared` do).
The verdict tool must therefore call **none** of those status-clearing methods —
the task must stay `status='running'` with `current_run_id` intact so that next
tick `reclaim()` can compute `runMode(currentRunId) === 'review'` and route it
(section 5). If the task were cleared here, `reclaim()` would read a NULL
`currentRunId`, default the mode to `'work'`, and misroute the task through the
generic failure path.

The tool only *records*; the dispatcher's `reclaim()` performs the status
transition and any bounce spawn (spawning lives in the dispatcher, consistent
with verify).

## 4. Reviewer profile (singleton)

- `WorkerProfile.role` gains `'reviewer'`: `'worker' | 'orchestrator' | 'reviewer'`.
- Exactly one reviewer profile, reserved name `reviewer`
  (`REVIEWER_PROFILE_NAME`), mirroring the orchestrator singleton
  (`ORCHESTRATOR_PROFILE_NAME`). Its default critic persona
  (`DEFAULT_REVIEWER_INSTRUCTIONS`) lives in `src/shared/types.ts` where both
  main and renderer reach it.
- **Missing-profile reality (B3):** existing users have a saved
  `profiles` array that is *not* re-merged with `DEFAULT_SETTINGS.kanban.profiles`
  (`settings-store.ts` only deep-merges `dispatcher`/`defaults`, not the profile
  list), and the orchestrator singleton is created lazily by the renderer
  Settings UI — main never seeds it. So the reviewer profile **will be absent**
  for every existing user until they open Settings. The `index.ts` spawn wiring
  (next section) MUST therefore resolve the reviewer as: the saved `reviewer`
  profile if present, else an in-memory profile built from
  `DEFAULT_REVIEWER_INSTRUCTIONS` (name `reviewer`, role `reviewer`, empty model
  → rune's normal provider resolution). Never fall back to the worker/orchestrator
  persona.
- Surfaced in Settings alongside the orchestrator: editable persona/model,
  "Reset to default" button. No assignment UI — the reviewer is never assigned
  to a task; the stage always uses the singleton.
- Default persona: a senior-reviewer critic — judge the diff against the task's
  acceptance criteria; approve when the change is correct, focused, and matches
  the spec; request changes with specific, actionable findings otherwise; do not
  nitpick style the verify commands already enforce.

### 4.1 `index.ts` spawnWorker wiring (`deps.spawnWorker` closure)

`reviewTasks()` and `spawnReviewFix()` both flow through the `deps.spawnWorker`
closure in `index.ts`, which does mode-dependent profile selection and prompt
assembly. Mode `'review'` must NOT fall into the existing orchestrator
else-branch, which has two traps:

1. **Assignee clobber (B3):** the orchestrator else-branch runs
   `updateTask(task.id, { assignee: 'orchestrator' })` for every mode that is not
   `'assign'`. For a review run that would overwrite the task's real worker
   assignee, poisoning the later `spawnReviewFix` (`startRun(task.assignee)`) and
   the card display. The review case must select the reviewer singleton (§4) and
   **never write `assignee`**.
2. **Persona fallback (B3):** `buildWorkerInvocation` falls back to `--profile
   <task.assignee>` for non-work modes when the named profile is absent — so a
   missing reviewer profile would run the review under the *worker's* persona.
   The review case must use the in-memory `DEFAULT_REVIEWER_INSTRUCTIONS`
   fallback (§4) instead.

Add a dedicated `'review'` branch to the closure: select the reviewer profile
(saved-or-default), build the prompt with the generated diff (§2), and (for the
`work`-mode bounce fix) thread the prior `findings` through. `SpawnWorkerArgs`
and `BuildWorkerInput` gain a `reviewFindings`/diff field pair mirroring how
#231 added `verifyFailure`.

## 5. `reclaim()` review branch

Placed alongside the existing `suggest` / `verify` reclaim branches (before the
generic exit-3 / blockNow branches — otherwise an exit-3 inconclusive run gets
`blockTask`'d). Applies when `runMode(task.currentRunId) === 'review'`.

**Alive-wait guard (B1), first:** replicate the verify branch's guard — if the
run has no recorded exit yet (`exit == null`) but the claim expired and the
worker pid is still alive, `extendClaim` and `continue`. A slow reviewer that
didn't heartbeat must not be escalated as "inconclusive" while still running
(that also orphans a process that could later try to write a verdict — the CAS
guard in §3 is the backstop, but don't create the race).

Otherwise, read the verdict the terminal tool recorded on the task:

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
  with no verdict recorded): `finishRun(runId, 'reclaimed')` then soft-escalate
  exactly as the cap case, append `review_escalated`
  (`{ reason: 'reviewer returned no verdict' }`). Never auto-approve.

**Verdict/attempt lifecycle.** A fresh `work` run starting on the task
(claimAndSpawn, verify-fix, or review-fix) calls `clearReviewVerdict(taskId)`,
which sets `review_verdict` and `review_head_sha` to NULL **and zeroes
`review_attempts`** — the diff has changed, so any prior approval is stale and
the next review episode starts with the full cap (S2; otherwise a re-worked task
that escalated at the cap would instantly re-escalate on its first new
`request_changes` with zero fix attempts). `incrementReviewAttempts` fires per
`spawnReviewFix`; `resetReviewAttempts` on `approve` is then redundant but
harmless and kept for symmetry with `resetVerifyAttempts`.

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
`clearReviewVerdict` and skip — `reviewTasks()` re-reviews it next tick. Cheap
insurance that `integrate()` merges exactly what was approved. The HEAD read goes
through a new injectable `IntegrationOps` op (e.g. `headSha({ workspacePath })`)
— `IntegrationOps` is the dispatcher's testability seam and has no HEAD-read op
today; the §3 verdict tool needs the same git-HEAD helper in `workspace.ts`. A
small TOCTOU window between assert and merge is accepted (a mid-tick mutation is
not a real scenario — the tick is synchronous).

**Resolve interaction (S3):** a `resolve` run (merge-conflict resolution)
modifies the tree *after* approval. `spawnResolve` therefore also calls
`clearReviewVerdict` so the resolved result is re-reviewed. (Even without that,
the HEAD-SHA assertion would catch it via the slower path — resolve completes →
lands review with a now-stale verdict → SHA mismatch → cleared → re-review — but
clearing on spawn is the direct route.)

## 7. Notifications

The human "ready for review" notification must fire **once**, on the agent
verdict, not when the task first enters `review` — otherwise `autoReview`
double-notifies (gate-pass *and* verdict).

**The `'completed'` kind is overloaded and cannot be the suppression key (B2).**
Today `appendEvent(..., 'completed', ...)` is emitted by both (a) the ungated
worktree review-landing (`kanban_complete`, the gate-pass we want to suppress)
*and* (b) scratch/dir/decompose task completion, which never enters the review
stage. Keying suppression on kind `'completed'` would silence (b) forever.

Fix:

- Change the **ungated worktree review-landing** to emit a distinct kind
  `review_ready` (instead of `'completed'`); scratch/dir/decompose keep
  `'completed'`. The verify-gated paths already emit distinct kinds
  (`verify_passed` / `verify_skipped`).
- The suppressible **gate-pass set** is therefore
  `{ review_ready, verify_passed, verify_skipped }` — all three land a worktree
  task in `review` with a NULL verdict (note `verify_skipped` is included: it
  fires on the verify fail-open paths and those tasks still get reviewed).
- When `autoReview` is **on**: suppress the gate-pass set on **both** channels —
  OS (in `KanbanNotifier.enqueue`) and badge (in the renderer
  `useKanbanAttention` hook, which calls `kanbanNotifyChannel(event.kind, …)`
  directly). Both call sites already have the settings in scope. Fire the
  review-ready notification instead on `review_passed` / `review_escalated`.
- When `autoReview` is **off**: nothing is suppressed and no `review_*` events
  are produced, so behavior is byte-for-byte today's.

`classifyKanbanEvent` mappings (static — suppression is a separate
`autoReview`-conditioned filter, not a classify change):

| Event kind | Category | Notes |
|---|---|---|
| `review_ready` | `completed` | ungated worktree landing (replaces `'completed'` for worktree tasks) |
| `review_passed` | `completed` | approve → task ready for merge/review |
| `review_escalated` | `completed` | cap/inconclusive → human attention needed |
| `review_changes_requested` | `null` | in-flight bounce; silent (like `verify_failed`) |
| `review_started` | `null` | informational; silent |

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

**Swarm exemption (S6).** `reviewTasks()` skips tasks that belong to a swarm
graph (they already get a dedicated agent verifier card via `verifierAssignee`).
This is harder than a single column: members are connected through `task_links`
up to a swarm **root**, and a root is identifiable only by parsing its blackboard
*comments* for the topology metadata `kind === 'kanban_swarm_v1'`
(`SWARM_ROOT_KIND`, currently **module-private** in `kanban-swarm.ts` — must be
exported). So `isSwarmMember(taskId)` is a transitive `task_links`-parent walk
(with a cycle guard) that checks each ancestor's blackboard for the swarm-root
marker. This runs only at review-candidate cardinality (a handful per tick), so
the cost is fine; the plan states the mechanism rather than implying a SQL
column.

**Role `'reviewer'` ripple (S8).** Adding `role: 'reviewer'` changes the
worker-roster filter the orchestrator sees. `index.ts` builds the assignable
roster as `profiles.filter(p => p.role !== 'orchestrator')` — a reviewer-role
profile would leak into the roster offered to decompose/assign runs (the MCP-side
`role === 'worker'` guards would then reject it, causing model retry churn). Flip
that filter to `role === 'worker'`, and audit the other `role` switch/branch
sites for the same assumption.

**Store methods to add** (mirroring resolve/verify equivalents):
`claimForReview` (CAS on `status='review'`; can reuse the generic
`claimForVerifyFix` re-claim mechanism — C3), `setReviewVerdict(taskId, decision,
headSha?)`, `incrementReviewAttempts`, `resetReviewAttempts`,
`clearReviewVerdict` (nulls verdict + head_sha **and** zeroes
`review_attempts`), `isSwarmMember(taskId)`, and the candidate query
`reviewPendingTasks()`. Plus a `headSha` git helper in `workspace.ts` and an
`IntegrationOps.headSha` op for the integrate assertion (§6). `rowToTask` /
`Task` gain `reviewVerdict`, `reviewAttempts`, `reviewHeadSha`.

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
  spawns a `review` run; skips swarm members, system tasks, non-worktree tasks,
  pruned-worktree tasks, and already-verdicted tasks; per-tick cap honored;
  `autoReview` off → no-op; spawn failure under `failureLimit` → back to
  `review`; spawn failure at `failureLimit` → soft-escalate; no throw.
- `reclaim()` review branch: alive-wait guard (`exit==null` + pid alive +
  expired claim → `extendClaim` + continue, not escalate); `approve` → status
  `review` + verdict + HEAD SHA + `review_passed`; `request_changes` under cap →
  `spawnReviewFix` (fresh `work` run, findings injected) + increment; at cap →
  soft-escalate (`review` + verdict retained + `review_escalated` + notify);
  inconclusive (no verdict) → `finishRun('reclaimed')` + soft-escalate; review
  branch precedes exit-3/blockNow (an exit-3 review run escalates, not blocks).
- `kanban_review_verdict`: approve records verdict + HEAD SHA + `reviewer`
  comment + event; request_changes records findings + event; rejects an invalid
  `decision`; rejects empty `summary`; CAS guard — a verdict for a non-current
  run / non-running task is a no-op; does NOT clear `current_run_id`.
- `integrate()` guard: `autoReview` on + verdict ≠ approve → skipped; verdict =
  approve + matching HEAD → merges; HEAD-SHA drift → `clearReviewVerdict` +
  re-review; `autoReview` off → behaves as #228/#231.
- `clearReviewVerdict` nulls verdict + head_sha **and** zeroes `review_attempts`;
  a fresh `work` run (claim/verify-fix/review-fix) and `spawnResolve` both call
  it.
- Notifications: classify maps `review_ready`/`review_passed`/`review_escalated`
  → `completed`, `review_changes_requested`/`review_started` → null; the gate-pass
  set `{review_ready, verify_passed, verify_skipped}` is suppressed on **both**
  OS and badge channels when `autoReview` on, and delivered when off; scratch/dir
  `'completed'` is never suppressed.
- `isSwarmMember`: a task linked under a `kanban_swarm_v1` root → true (with a
  cycle in `task_links` not hanging); an ordinary feature task → false.
- Roster filter: a `reviewer`-role profile is excluded from the orchestrator's
  assignable worker roster.

## 12. Implementation phasing

One plan, TDD task order:

1. Types + schema migration 15 (`review_verdict`, `review_attempts`,
   `review_head_sha`, `RunMode 'review'`, `role 'reviewer'`, `autoReview`
   setting, `rowToTask`/`Task` fields) + full store suite.
2. Store methods (`claimForReview`, `setReviewVerdict`, `increment/reset/
   clearReviewVerdict`, `reviewPendingTasks`, `isSwarmMember`,
   `orchestratorRunningCount` excludes `review`) + `SWARM_ROOT_KIND` export +
   `workspace.ts` `headSha` helper + `IntegrationOps.headSha` op.
3. Reviewer profile singleton + `DEFAULT_REVIEWER_INSTRUCTIONS` +
   `requireToolsForMode` case + `buildPrompt` review block + diff generator +
   `reviewDiffPath` dep.
4. `index.ts` `deps.spawnWorker` `'review'` branch (profile resolve-or-default,
   no assignee write, diff/findings fields) + roster filter flip to
   `role === 'worker'` + mode-aware comment author.
5. `kanban_review_verdict` terminal tool (record-only + CAS guard + no
   status-clear).
6. `reviewTasks()` dispatcher stage (claim + spawn + spawn-failure bound).
7. `reclaim()` review branch (alive-wait guard + approve/bounce/escalate) +
   `spawnReviewFix` + `clearReviewVerdict` on every fresh-work / resolve spawn.
8. `integrate()` approve-guard + HEAD-SHA assertion.
9. Notifications (`review_ready` kind, classify table, dual-channel gate-pass
   suppression).
10. UI badges + Settings reviewer editor.
