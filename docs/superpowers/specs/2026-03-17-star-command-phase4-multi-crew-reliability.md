# Star Command Phase 4: Multi-Crew + Reliability

## Overview

Run multiple Crewmates concurrently with proper isolation, failure detection, and automatic recovery. Adds the Sentinel watchdog, startup reconciliation, concurrent worktree coordination, merge conflict handling, and PR creation.

## Prerequisites

- Phase 1 complete: StarbaseDB, schema, SectorService, ConfigService
- Phase 2 complete: Hull, WorktreeManager, MissionService, CrewService, Ship's Log writes
- Phase 3 complete: Admiral, CommsService, Star Command tab

## Architecture

### Sentinel (`src/main/starbase/sentinel.ts`)

A watchdog that runs periodic sweeps to detect and handle failures.

**Sweep interval:** 10 seconds (configurable via `lifesign_interval_sec` in starbase_config).

**Each sweep performs:**

1. **Lifesign check:** Query `crew WHERE status = 'active' AND last_lifesign < datetime('now', '-{timeout} seconds')`. Mark matches as "lost". Insert Ship's Log entry. Send Transmission to Admiral (type: "lifesign_lost").

2. **Mission deadline check:** Query `crew WHERE status = 'active' AND deadline IS NOT NULL AND deadline < datetime('now')`. For each: terminate the Hull (SIGTERM), Hull's exit handler marks "timeout" and runs cleanup.

3. **Sector path validation:** For each registered Sector, check `root_path` exists on disk. If missing: mark all Crew in that Sector as "lost", disable Sector in registry, log to Ship's Log, hail Admiral.

4. **Dependency deadlock detection:** Query Missions where `status = 'active'` and the assigned Crewmate has been "hailing" for > 2x the Mission timeout. Escalate to Admiral: "Mission A is blocking Mission B and has been hailing for N minutes."

5. **Disk usage check:** Calculate total size of `~/.fleet/worktrees/` using `du -sk` (fast, single syscall per directory). Cache the result for 60 seconds to avoid running `du` on every 10-second sweep. Compare against `worktree_disk_budget_gb`. Warn Admiral at 90%, refuse new deployments at 95%.

6. **System memory check:** Read `os.freemem()`. If below 1GB, warn Admiral. If below 512MB, refuse new deployments.

7. **Comms rate limit reset:** On a separate 60-second sub-interval (tracked by a counter: every 6th sweep), reset all `comms_count_minute` values to 0 in the `crew` table.

**Constructor:** Takes `{ db, crewService, missionService, sectorService, configService }`.

**Public API:**
- `start()` — Begin the sweep interval
- `stop()` — Clear the interval
- `runSweep()` — Execute one sweep (also callable manually)

### Startup Reconciliation (`src/main/starbase/reconciliation.ts`)

Runs once on app launch to recover from crashes.

**Reconciliation sequence:**

1. Query all Crew with `status = 'active'`
2. For each, check if PID is alive: `process.kill(pid, 0)` (signal 0 = existence check). To guard against PID reuse, also compare the crew's `created_at` timestamp — if the PID is alive but the crew was created more than 24 hours ago, treat as stale (PID reused by a different process).
3. Dead PIDs → mark "lost" in crew table, insert Ship's Log entry ("lost during app restart")
4. Preserve worktree branches for dead Crew (do NOT clean up — user may want to recover)
5. Run `git worktree prune` on each Sector's repo to clean stale git references
6. Sweep `~/.fleet/worktrees/{starbaseId}/` — remove directories not tracked in crew table (orphaned from previous crashes)
7. Check for Missions with status "push-pending" — retry the push for each
8. Check for Missions with status "active" whose Crew is now "lost" — reset to "queued" for redeployment
9. Return a summary: `{ lostCrew: [...], orphanedWorktrees: [...], retriedPushes: [...], requeuedMissions: [...] }`

The Admiral surfaces this summary on first interaction: "Found N lost Crew from last session. Crewmate X had 3 commits on branch crew/X. Redeploy or recover manually?"

### Concurrent Worktree Coordination

**WorktreeManager changes:**

- `create()` now checks `max_concurrent_worktrees` from config. If at the limit, throws a `WorktreeLimitError` instead of creating.
- CrewService catches `WorktreeLimitError` and queues the Mission instead of deploying. Sets mission status to "queued" with a note "deployment deferred: worktree limit reached."
- When a Hull completes and calls WorktreeManager.remove(), the CrewService checks for deferred Missions and auto-deploys the next one.

**Auto-deploy on free slot:**
After any Crewmate completes (Hull exit handler), CrewService:
1. Cleans up the worktree
2. Queries `nextMission()` across all Sectors using a global query: `SELECT * FROM missions WHERE status = 'queued' AND (depends_on_mission_id IS NULL OR depends_on_mission_id IN (SELECT id FROM missions WHERE status = 'completed')) ORDER BY priority ASC, created_at ASC LIMIT 1`. This is FIFO within the same priority level, lowest priority number first.
3. If a queued Mission exists and worktree count is below limit, auto-deploys it
4. Sends a Transmission to Admiral: "Auto-deployed Mission #{id} to {Sector} after {crewId} completed"

### Worktree Pool

**WorktreeManager additions:**

- `recycle(worktreePath, baseBranch)` — Instead of removing, reset the worktree: `git checkout {baseBranch}`, `git pull`, `git clean -fd`, `git checkout -b crew/{newCrewId}`. Returns the recycled worktree path.
- `getPooled(starbaseId)` — List recycled worktrees available for reuse. Pool tracked in the `crew` table via a `pool_status` column: `NULL` (active), `"pooled"` (available for reuse), with `pooled_at` timestamp. This avoids the race condition of a JSON file — SQLite's write serialization handles concurrent access.
- `evictStale()` — Remove pooled worktrees older than 1 hour.
- `create()` checks for pooled worktrees first before creating a new one.

### Merge Conflict Handling

**Hull changes on Mission completion:**

After pushing the branch, before worktree cleanup:

1. Check if base branch has moved since worktree creation: `git rev-list {baseBranch}..origin/{baseBranch} --count`
2. If base branch moved:
   a. Attempt rebase: `git rebase origin/{baseBranch}`
   b. If rebase succeeds cleanly → push with `git push --force-with-lease origin {worktreeBranch}` (safer than `--force` — fails if someone else pushed to the branch), continue normally
   c. If rebase fails → `git rebase --abort`, push the un-rebased branch, proceed to PR creation with draft status
3. On conflict, include conflicting file list in the Comms Transmission to Admiral

### PR Creation

**Hull changes — merge strategy execution after push:**

- **"pr" (default):** Run `gh pr create --title "{mission.summary}" --body "{prBody}" --base {baseBranch} --head crew/{crewId}`. If rebase had conflicts, create as draft: `--draft`. Add labels: `fleet`, `sector/{sectorId}`, `mission/{missionId}`.

  PR body template:
  ```
  ## Mission: {summary}

  **Sector:** {sector name}
  **Crewmate:** {crewId} ({avatar variant})
  **Duration:** {started → completed}

  ### Changes
  {git diff --stat output}

  ### Mission Debrief
  {result summary from crew output}

  ---
  Deployed by Star Command | Starbase: {starbaseId}
  ```

- **"auto-merge":** Create PR as above, then `gh pr merge --auto --squash`. If merge conflicts, leave open and hail Admiral.
- **"branch-only":** Skip PR creation entirely.
- **Fallback:** If `gh` is not installed or not authenticated (`gh auth status` fails), fall back to "branch-only" and warn Admiral.

Hull checks `gh` availability once at startup (cached). If a PR creation fails mid-session (e.g. auth token expired), the Hull falls back to "branch-only" for that specific PR, warns the Admiral, and invalidates the cache so the next PR creation re-checks `gh auth status`.

**Event types note:** Phase 4 extends the parent spec's Ship's Log event types with: "timeout", "push_failed", "push_retried", "worktree_cleanup_failed", "sector_path_missing", "reconciliation". The `event_type` column is a free-form TEXT — no schema change needed, just document the new values.

### Comms Rate Limiting

**CrewService / CommsService changes:**

- `crew` table gets a `comms_count_minute` column (INTEGER, reset every 60s by the Sentinel sweep)
- Before inserting a Transmission, CommsService checks the sender's rate. If above `comms_rate_limit_per_min`, reject with error and log to Ship's Log.
- Sentinel sweep resets all `comms_count_minute` values to 0 every 60 seconds (via the 60-second sub-interval described in the Sentinel section above).

### Ship's Log Service (`src/main/starbase/ships-log.ts`)

Append-only audit trail.

**Public API:**
- `log({ crewId, eventType, detail })` — Insert into ships_log table. detail is JSON-stringified.
- `query({ crewId?, eventType?, since?, limit? })` — Query with filters.
- `getRecent(limit)` — Last N entries across all Crew.

**Event types:** "deployed", "exited", "lost", "redeployed", "timeout", "lifesign_lost", "comms_failed", "push_failed", "push_retried", "worktree_cleanup_failed", "sector_path_missing", "reconciliation"

### Lockfile (`src/main/starbase/lockfile.ts`)

Prevents duplicate Fleet instances managing the same Starbase.

**Implementation:**
- On Starbase open: write `starbase-{id}.lock` in `~/.fleet/starbases/` containing `{ pid, timestamp }`
- Check if lock exists. If yes, check if PID is alive (`process.kill(pid, 0)`). Also compare the lock's `timestamp` — if the lock is older than 24 hours, treat as stale regardless of PID (guards against PID reuse). If alive and recent → read-only mode. If dead or stale → overwrite.
- On Starbase close / app quit: remove the lockfile.
- Read-only mode: all write IPC handlers return errors, Admiral input is disabled, UI shows "This Starbase is managed by another Fleet instance."

## What Is NOT Built

- Supply Routes / cross-Sector Cargo forwarding
- Quality Gates (Gate 2 verify commands, Gate 3 Admiral review)
- Mission decomposition (Admiral still deploys literal requests)
- Config panel UI
- Pixel art visualizer
- Database retention / cleanup

## Tests

- **Sentinel:** Mock database with stale Crew (old Lifesigns), verify they get marked "lost". Mock expired deadlines, verify termination. Mock missing Sector paths, verify disable.
- **Reconciliation:** Mock PIDs (some alive, some dead), verify correct status updates. Verify orphaned worktree cleanup. Verify push-pending retry.
- **Concurrent worktrees:** Deploy at limit, verify Mission queued. Complete one, verify auto-deploy triggers.
- **Worktree pool:** Recycle, reuse, evict stale.
- **Merge conflicts:** Mock rebase failure, verify draft PR + conflict file list in Comms.
- **PR creation:** Mock `gh` CLI, verify PR body, labels, merge strategies. Verify fallback when `gh` unavailable.
- **Rate limiting:** Send Transmissions above limit, verify rejection.
- **Lockfile:** Create, detect stale, read-only mode.
