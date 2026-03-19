# Duplicate Crew Deployments Investigation

## Summary

Multiple crew can be deployed to the same mission due to missing status guards in the deployment handler, no unique database constraints, and race conditions between `autoDeployNext()`, the Sentinel sweep loop, and the First Officer AI agent.

---

## Full Crew Deployment Code Path

The deployment flow passes through four layers:

### Layer 1 — CLI Entry (`src/main/fleet-cli.ts`)
- `runCLI()` parses `fleet crew deploy --mission <id>` into a `crew.deploy` command.
- `validateCommand()` (line 374) only checks that `--mission` is numeric and non-zero. No status check is performed.
- The validated command is forwarded to the socket server via `FleetCLI.send()`.

### Layer 2 — Socket Server (`src/main/socket-server.ts`, lines 417–472)
- `dispatch()` handles `crew.deploy`. It verifies the mission exists and has a non-empty prompt, and checks `depends_on_mission_id` completion.
- **There is no check on `mission.status`.** A mission that is already `active`, `completed`, `pending-review`, or `reviewing` will be deployed again without any guard.
- Calls `crewService.deployCrew(...)`.

### Layer 3 — CrewService (`src/main/starbase/crew-service.ts`, lines 71–193)
- `deployCrew()` checks: sector exists, `missionId` is truthy, prompt is non-empty, free RAM exceeds `min_deploy_free_memory_gb` (otherwise queues), worktree slot available (otherwise queues).
- **None of these checks verify whether the mission already has an active crew or is in a non-deployable status.**
- After checks pass, a new `crewId` is generated, a worktree is created, and `Hull.start()` is called.

### Layer 4 — Hull (`src/main/starbase/hull.ts`, lines 93–116)
- `start()` performs two unconditional database operations with no conflict handling:
  - `INSERT INTO crew (id, ...) VALUES (...)` — inserts a new crew row.
  - `UPDATE missions SET status = 'active', crew_id = ?, started_at = datetime('now') WHERE id = ?` — overwrites `crew_id` with the new crew, silently discarding the previous crew's reference.

---

## Root Causes

### Root Cause A: No mission status guard in `crew.deploy` handler (Primary)
**File:** `src/main/socket-server.ts` (line ~464)

The `crew.deploy` handler calls `crewService.deployCrew()` after only confirming the mission exists and has a prompt. It never reads `mission.status`. Any caller — human or automated — can invoke `fleet crew deploy --mission X` when mission X is already `active`, and the system will spawn a second `claude` process against a second git worktree. Both hulls independently write `UPDATE missions SET crew_id = ?`, so `missions.crew_id` ends up pointing to whichever crew finished activating last. The old crew is orphaned but keeps running.

### Root Cause B: No unique database constraint on crew per mission
**File:** `src/main/starbase/migrations.ts` (lines 43–59)

The `missions` table schema defines `crew_id` as:
```sql
crew_id TEXT,
```
No `UNIQUE` constraint, no `CHECK`, no trigger. Multiple rows in the `crew` table can also reference the same `mission_id` without any enforcement. SQLite will not prevent double-assignment.

### Root Cause C: `autoDeployNext()` races with external `crew.deploy` calls
**File:** `src/main/starbase/crew-service.ts` (lines 285–299)

`autoDeployNext()` is called from `Hull.onComplete` inside the `finally` block of `cleanup()`. It:
1. Calls `nextQueuedMission()` — reads `WHERE status = 'queued'`.
2. Immediately calls `deployCrew()`.

These two operations are not wrapped in a transaction or mutex. If an external `fleet crew deploy --mission X` call arrives between them, or if two Hull completions fire near-simultaneously, both can observe the same mission in `queued` status and independently deploy a crew.

Node.js is single-threaded, but `nextQueuedMission()` and `deployCrew()` interleave at `await` suspension points inside `deployCrew()` — specifically at `await getAvailableMemoryBytes()` and `await worktreeManager.create()`.

### Root Cause D: Sentinel `reviewSweep()` fix-crew path has no atomic claim
**File:** `src/main/starbase/sentinel.ts` (lines 519–571)

The `pending-review` → `reviewing` transition (line 454) correctly uses a compare-and-swap:
```sql
UPDATE missions SET status = 'reviewing' WHERE id = ? AND status = 'pending-review'
-- then: SELECT changes()
```
This prevents duplicate review deployments for that path.

However, the `changes-requested` fix-crew path has **no equivalent guard**. It reads missions with `status = 'changes-requested'` and calls `deployCrew()` directly without first atomically claiming the mission with a status transition.

Additionally, `runSweep()` has no re-entrancy guard. If one sweep is still awaiting `deployCrew()` (waiting on async worktree creation) when the next sweep interval fires, the new sweep will also find `status = 'changes-requested'` missions and attempt to deploy fix crews.

### Root Cause E: First Officer AI races with `autoDeployNext()`
**Files:** `src/main/starbase/sentinel.ts` (lines 255–341), `src/main/starbase/first-officer.ts` (lines 379–388)

The First Officer's prompt instructs the AI agent to:
1. Reset the errored crew.
2. Run `fleet missions update <mission-id> --status queued`.
3. Run `fleet crew deploy --sector <id> --mission <mission-id>`.

The `isRunning` check (line 297 in sentinel) only prevents two First Officer *processes* from running for the same crew+mission pair. It does not prevent a race where:
- The First Officer fires `fleet crew deploy --mission X`.
- Simultaneously, `autoDeployNext()` (triggered by an unrelated crew completion) also picks up mission X, which the First Officer just re-queued via `missions update --status queued`.

Both calls then hit the unguarded `deployCrew()` path and two crews are deployed.

---

## Specific Files and Line Numbers

| File | Location | Issue |
|---|---|---|
| `src/main/socket-server.ts` | ~line 464 | `crew.deploy` handler — no `mission.status` guard before calling `deployCrew()` |
| `src/main/starbase/crew-service.ts` | lines 71–193 | `deployCrew()` — no check for existing active crew on the mission |
| `src/main/starbase/crew-service.ts` | lines 285–299 | `autoDeployNext()` — non-atomic read-then-deploy, no in-flight lock |
| `src/main/starbase/hull.ts` | lines 93–116 | `start()` — unconditional `UPDATE missions SET crew_id = ?`, no conflict guard |
| `src/main/starbase/hull.ts` | ~line 878–885 | `onComplete` triggers `autoDeployNext()` — can fire concurrently |
| `src/main/starbase/sentinel.ts` | lines 519–571 | `reviewSweep()` fix-crew path — no atomic mission claim before deploying |
| `src/main/starbase/sentinel.ts` | lines 255–341 | `firstOfficerSweep()` — First Officer AI re-queues mission; races with `autoDeployNext()` |
| `src/main/starbase/first-officer.ts` | lines 379–388 | First Officer prompt — instructs AI to call `fleet crew deploy` directly |
| `src/main/starbase/migrations.ts` | lines 43–59 | Schema — no `UNIQUE` constraint on `missions.crew_id` or `crew.mission_id` |
| `src/main/starbase/mission-service.ts` | lines 93–100, 143–151 | `activateMission()` / `resetForRequeue()` — unconditional updates, no status pre-check |
| `src/main/starbase/reconciliation.ts` | lines 134–145 | On restart, re-queues active missions; can race with in-flight deployments |

---

## Recommended Fix Approach

### Fix 1: Add mission status guard to the `crew.deploy` handler (highest priority)
In `socket-server.ts`, before calling `deployCrew()`, fetch `mission.status` and reject the request if it is `active`, `reviewing`, `pending-review`, or `completed`. Return an actionable error message.

### Fix 2: Add a database unique constraint
Add a migration to enforce at the database level:
```sql
-- Prevent multiple active crew per mission
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_mission_unique
  ON crew (mission_id) WHERE status != 'lost' AND status != 'recalled';
```
This makes duplicate crew assignment a hard error at the SQLite layer, catching any path that bypasses application-level guards.

### Fix 3: Make `autoDeployNext()` use an atomic claim
Replace the read-then-deploy pattern with a single atomic SQL update that transitions the mission from `queued` to `deploying` (a new transient status) as part of claiming it:
```sql
UPDATE missions SET status = 'deploying'
  WHERE id = (SELECT id FROM missions WHERE status = 'queued' ORDER BY created_at LIMIT 1)
    AND status = 'queued'  -- optimistic lock
RETURNING id;
```
Only proceed with `deployCrew()` if `changes()` returns 1. This eliminates the race between concurrent `autoDeployNext()` calls and between `autoDeployNext()` and external `crew.deploy` invocations.

### Fix 4: Add re-entrancy guard to `Sentinel.runSweep()`
Track whether a sweep is currently running with a boolean flag. Skip the new sweep if the previous one has not completed:
```ts
if (this.sweepInProgress) return;
this.sweepInProgress = true;
try { await this.reviewSweep(); } finally { this.sweepInProgress = false; }
```

### Fix 5: Apply the compare-and-swap pattern to the `changes-requested` path
In `sentinel.ts`, the fix-crew deployment for `changes-requested` missions should atomically claim the mission using the same pattern already used for `pending-review`:
```sql
UPDATE missions SET status = 'reviewing' WHERE id = ? AND status = 'changes-requested'
-- check changes() before calling deployCrew()
```

---

## Related Edge Cases

### Reconciliation races with in-flight deployments (`src/main/starbase/reconciliation.ts`, lines 134–145)
On restart, any crew whose PID is dead is marked `lost` and their missions are reset to `status = 'queued', crew_id = NULL`. If reconciliation runs while the old process is still spinning down (PID briefly survives the check), and `autoDeployNext()` fires simultaneously on app startup, the mission could be deployed again before reconciliation completes.

### `mission update --status queued` does not validate current status (`src/main/socket-server.ts`, lines 354–358)
Any caller (including the First Officer AI) can unconditionally set a mission to `queued` regardless of its current state. A currently `active` mission can be re-queued, putting it back into the `nextQueuedMission()` pool without recalling the existing crew. This is the mechanism by which the First Officer inadvertently triggers the race with `autoDeployNext()`.

### The one correct pattern (for reference)
The `pending-review` → `reviewing` transition in `sentinel.ts` (line 454) is the only place in the codebase that correctly uses an optimistic lock via compare-and-swap + `SELECT changes()`. All other deployment paths should be updated to follow this same pattern.
