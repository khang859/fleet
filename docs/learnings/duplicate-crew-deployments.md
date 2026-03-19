# Duplicate Crew Deployments Investigation

**Date:** 2026-03-19
**Status:** Read-only investigation — no code modified

---

## Summary

Multiple crew can be deployed to the same mission due to several race conditions and missing guards across the crew deployment pipeline. The root causes span the CLI handler, the `autoDeployNext()` auto-dispatch loop, the First Officer review/retry cycle, and the sentinel's `changes-requested` handling. There is also no database-level constraint preventing multiple crew rows from referencing the same mission.

---

## Full Crew Deployment Code Path

```
fleet crew deploy --mission <id>
  → fleet-cli.ts:374         (CLI parses args, sends socket message)
  → socket-server.ts:417     (crew.deploy handler: validates mission + prompt)
  → crew-service.ts:71       (deployCrew(): memory check, worktree, crew insert)
  → hull.ts:114              (Hull.start(): UPDATE missions SET crew_id = ?, status = 'active')
```

**Key files:**
- `src/main/fleet-cli.ts:374` — CLI entry point
- `src/main/socket-server.ts:417–472` — socket handler for `crew.deploy`
- `src/main/starbase/crew-service.ts:71–193` — `deployCrew()` implementation
- `src/main/starbase/hull.ts:114–116` — where `missions.crew_id` is actually written

### How `crew_id` Gets Set

`missions.crew_id` is set inside `Hull.start()` at `hull.ts:114`:
```sql
UPDATE missions SET status = 'active', crew_id = ?, started_at = datetime('now') WHERE id = ?
```

This runs unconditionally — there is no `WHERE crew_id IS NULL` or `WHERE status = 'queued'` guard. Any concurrent caller that reaches this point will overwrite the existing `crew_id`.

---

## Root Causes of Duplicate Deployments

### Issue 1 (Critical): `autoDeployNext()` has no atomic mission claim

**File:** `src/main/starbase/crew-service.ts:285–299`

When a Hull completes, it calls `autoDeployNext()`, which:
1. Calls `nextQueuedMission()` — a plain `SELECT … LIMIT 1` with no locking
2. Immediately calls `deployCrew()` on the result

If two Hulls complete at nearly the same time (common with many concurrent agents), both `autoDeployNext()` calls will read the same queued mission (the `SELECT` is not atomic with the deploy) and both will call `deployCrew()` for the same mission ID. This is a classic check-then-act race with no locking.

`nextQueuedMission()` at `crew-service.ts:259` does a bare `SELECT … WHERE status = 'queued' LIMIT 1` — there is no `BEGIN IMMEDIATE` transaction, no `UPDATE … WHERE status = 'queued' RETURNING id` compare-and-swap, and no intermediate `'deploying'` status to mark a mission as claimed.

### Issue 2 (Critical): Re-queue races with `autoDeployNext()`

**Files:** `src/main/socket-server.ts:354–358`, `src/main/starbase/crew-service.ts:285–299`

When the First Officer issues `fleet missions update <id> --status queued`, the socket handler calls `missionService.resetForRequeue(id)`, which sets `crew_id = NULL` and `status = 'queued'`. This mission immediately becomes eligible for `autoDeployNext()`.

If any other Hull completes at this moment, `autoDeployNext()` picks up the newly re-queued mission and deploys a crew — before the First Officer issues its explicit `fleet crew deploy` command. Both the auto-deploy and the First Officer's manual deploy will proceed, producing two crew for the same mission.

### Issue 3 (Critical): `crew.deploy` handler does not check for existing active crew

**File:** `src/main/socket-server.ts:440–471`

The `crew.deploy` socket handler validates:
- Mission exists
- Prompt is non-empty
- Dependency is satisfied

It does **not** check:
- Whether `missions.crew_id` is already set
- Whether `missions.status` is already `'active'`
- Whether any crew row with `mission_id = X` is currently running

Two concurrent `fleet crew deploy --mission <id>` invocations will both pass validation and both reach `deployCrew()`. Similarly, `deployCrew()` itself has no such guard (`crew-service.ts:71–193`).

### Issue 4 (High): `changes-requested` path missing compare-and-swap

**File:** `src/main/starbase/sentinel.ts:519–572`

The sentinel's `reviewSweep()` handles `changes-requested` missions by calling `crewService.deployCrew()` to deploy a fix crew. Unlike the `pending-review` path (which does a correct atomic:
```sql
UPDATE missions SET status = 'reviewing' WHERE id = ? AND status = 'pending-review'
```
and checks `changes()`), the `changes-requested` path queries missions with `status = 'changes-requested'` at `sentinel.ts:496` but does **not** perform a compare-and-swap before deploying. If two sweep intervals overlap (possible if a sweep is still running when the next timer fires), both could deploy a fix crew to the same mission.

### Issue 5 (High): No database unique constraint

**File:** `src/main/starbase/migrations.ts:42–59`

The `missions` table schema:
```sql
crew_id TEXT,   -- nullable, no UNIQUE constraint
```

The `crew` table allows multiple rows with the same `mission_id`:
```sql
missions_id INTEGER REFERENCES missions(id)
-- no UNIQUE index on missions_id
```

There is no database-level last-resort prevention. Multiple `deployCrew()` calls will each insert a new crew row and each overwrite `missions.crew_id` — the DB will accept all of it.

### Issue 6 (High): First Officer recall is async with no confirmation

**Files:** `src/main/starbase/hull.ts:284–308`, `src/main/starbase/first-officer.ts:376–389`

The First Officer's retry sequence is:
1. `fleet crew recall <crew-id>` — sends SIGTERM, waits up to 10s for SIGKILL
2. `fleet missions update <mission-id> --status queued --prompt "..."` — re-queues
3. `fleet crew deploy ...` — deploys new crew

`crew recall` calls `hull.kill()` which is asynchronous — cleanup (including final `UPDATE missions`) runs in the `proc.on('exit')` callback. There is no synchronous confirmation to the caller that the old hull is fully terminated. A fast LLM agent (or a busy event loop) can issue all three commands before the old hull's exit handler fires. The old hull may still be in teardown when the new hull starts, meaning two hulls briefly run for the same mission.

### Issue 7 (Lower): First Officer in-memory dedup cleared on restart

**File:** `src/main/starbase/first-officer.ts:61–63, 507–511`

`FirstOfficer.isRunning()` uses an in-memory `Map` to prevent dispatching two First Officers for the same crew. This is correct for normal operation, but the `Map` is reset by `reconcile()` on startup. If the app restarts while a First Officer is running, the `isRunning()` check will return false and a new dispatch will occur for the same crew.

---

## The One Correct Pattern (for reference)

The `pending-review` path in `sentinel.ts:452–456` uses the correct compare-and-swap:
```sql
UPDATE missions SET status = 'reviewing' WHERE id = ? AND status = 'pending-review'
```
Then checks `db.prepare('SELECT changes()').get()` — if `changes = 0`, another process already claimed it and this one aborts. This pattern should be applied everywhere a mission is claimed for deployment.

---

## Recommended Fix Approach

### Fix 1: Atomic mission claim before any `deployCrew()` call

Introduce a `'deploying'` transitional status. Before calling `deployCrew()`, run:
```sql
UPDATE missions SET status = 'deploying' WHERE id = ? AND status IN ('queued', 'changes-requested')
```
Check `changes()`. If `changes = 0`, the mission was already claimed — abort. SQLite serializes writes, so this is race-safe without additional application-level locks.

Apply this in:
- `crew-service.ts` `autoDeployNext()` (before `deployCrew()`)
- `sentinel.ts` `changes-requested` handler (before `deployCrew()`)

### Fix 2: Guard `deployCrew()` against already-active missions

At the start of `deployCrew()` in `crew-service.ts:71`:
```sql
SELECT status, crew_id FROM missions WHERE id = ?
```
If `status = 'active'` or `crew_id IS NOT NULL`, throw an error (or return early). This is a safety net, not a replacement for Fix 1.

### Fix 3: Guard the `crew.deploy` socket handler

In `socket-server.ts:440`, before calling `crewService.deployCrew()`, check that the mission does not already have an active crew:
```sql
SELECT status FROM missions WHERE id = ?
```
Reject with an error if `status = 'active'`.

### Fix 4: Fix the re-queue race with `autoDeployNext()`

Two options (use either or both):
- **Option A:** `resetForRequeue()` sets status to `'queued'`, but `autoDeployNext()` only fires when a Hull completes. Ensure that `resetForRequeue()` also sets a `requeue_pending = 1` flag, and `autoDeployNext()` skips missions with that flag until the First Officer's explicit `deploy` clears it.
- **Option B (simpler):** If the First Officer is handling a mission, it should not call `missions update --status queued` before its `crew deploy` is ready. Instead, combine the re-queue and deploy into a single atomic operation: a new `crew.redeploy` command that recalls old crew, re-queues, and deploys atomically.

### Fix 5: Add a unique constraint on `crew.mission_id` (or a `crew.active` flag)

At minimum, add a partial unique index:
```sql
CREATE UNIQUE INDEX crew_mission_active ON crew(mission_id) WHERE status = 'active';
```
This ensures only one active crew row can exist per mission at the database level, providing a last-resort guard.

### Fix 6: Make `crew.recall` synchronous before re-deploy

In the First Officer system prompt (`first-officer.ts:376–389`), add an explicit wait or confirmation step between recall and deploy — or implement a `crew.swap` command that handles recall + deploy atomically.

---

## Related Edge Cases

- **Reconciliation on restart** (`src/main/starbase/reconciliation.ts`): On startup, missions with dead crew are reset to `'queued'`. If two nodes (or two rapid restarts) reconcile simultaneously, both could reset and re-queue the same mission, then `autoDeployNext()` picks it up twice.
- **Memory queuing**: `deployCrew()` throws `InsufficientMemoryError` and the mission stays `'queued'`. When memory frees up, `autoDeployNext()` will retry — but if the mission was manually re-queued in the meantime, the same two-deploy race can occur.
- **Sector slot limits**: The sector capacity check at `crew-service.ts:~100` is also a read-then-act — it reads current crew count then spawns. Two deploys in rapid succession can both pass the slot check but together exceed the limit.
