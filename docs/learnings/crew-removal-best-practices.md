# Crew Removal Best Practices

> Reference for managing completed crew member lifecycle in Fleet.
> Written: 2026-03-19

---

## 1. Current Implementation

### Crew Lifecycle States

Crew records move through a well-defined state machine:

```
pending → active → complete
                 ↘ error
                 ↘ timeout
                 ↘ lost
                 ↘ aborted
                 ↘ dismissed   ← set when you recall a terminal crew
```

All non-active states are **terminal** — the Hull process is gone and the crew is idle. The crew record stays in the DB for auditing and UI display until the retention window expires.

### How Cleanup Currently Works

There are **four layers** of crew cleanup, each handling a different scenario:

#### Layer 1 — Hull.cleanup() (`hull.ts:426`)

Called automatically when the Claude Code subprocess exits (success, error, timeout, or recall). This is the **primary cleanup path** for normally-completing crew.

What it does:
- Deletes temp prompt/system-prompt files from `/tmp/fleet-prompts/`
- Clears the lifesign and timeout timers
- Auto-commits any uncommitted changes in the worktree
- Pushes the branch to origin
- Creates a GitHub PR (if `gh` is authenticated)
- Updates mission status in the DB
- **Removes the git worktree** (`git worktree remove`) in the `finally` block
- Sets `crew.status` to final value (`complete`, `error`, `timeout`, `aborted`)

The worktree is preserved only when `status === 'push-pending'` (push failed — retry needed at next reconciliation).

#### Layer 2 — CrewService.recallCrew() (`crew-service.ts:200`)

The user-facing removal command (`fleet crew recall <crew-id>`).

```typescript
recallCrew(crewId: string): void {
  const hull = this.hulls.get(crewId);
  if (hull) {
    hull.kill();           // graceful stdin close → SIGTERM (5s) → SIGKILL (10s)
    this.hulls.delete(crewId);
    return;
  }

  // Post-restart recall: Hull not in memory — update DB directly
  if (TERMINAL_STATUSES.includes(row.status)) {
    // Mark as dismissed (acknowledged and cleared from UI)
    db.prepare("UPDATE crew SET status = 'dismissed' ...").run(crewId);
  } else {
    // Active crew with no hull is inconsistent — mark as lost
    db.prepare("UPDATE crew SET status = 'lost' ...").run(crewId);
  }
}
```

When you recall a **completed** crew, it transitions to `dismissed`. Dismissed crew are hidden from `fleet crew list` (which only shows `active`, `complete`, `error`, `timeout`) and will be hard-deleted by retention cleanup after the window expires.

#### Layer 3 — Reconciliation (`reconciliation.ts:34`)

Runs once at app startup. Handles the app-crash / dirty-restart scenario:

- Queries all `active` crew and checks if their PIDs are still alive
- Marks dead PIDs and stale crew (>24h) as `lost`
- Re-queues their missions so work is not lost
- Removes **orphaned worktree directories** (directories on disk that have no matching DB record)
- Cleans up lingering worktree directories for `error`/`timeout` crew (unless mission is `push-pending`)
- Runs `git worktree prune` on every sector

#### Layer 4 — RetentionService.cleanup() (`retention-service.ts:23`)

Hard-deletes aged records from the DB. Default retention windows (configurable via `fleet config`):

| Table      | Default Retention | Config Key                   |
|------------|------------------|------------------------------|
| crew       | 7 days           | `crew_retention_days`        |
| comms      | 30 days          | `comms_retention_days`       |
| cargo      | 14 days          | `cargo_retention_days`       |
| ships_log  | 30 days          | `ships_log_retention_days`   |

Only crew with terminal statuses are eligible for deletion:
```sql
DELETE FROM crew
WHERE status IN ('error', 'complete', 'timeout', 'lost', 'aborted', 'dismissed')
AND updated_at < datetime('now', '-' || ? || ' days')
```

**Important:** Retention cleanup does NOT remove research cargo files from disk (`~/.fleet/starbases/starbase-{id}/cargo/`). Those files outlive their DB records until manually deleted or cargo retention expires.

---

## 2. Completed Crew Handling

### What Happens to a Completed Crew

When a crew finishes successfully:

1. **Worktree**: Removed by `Hull.cleanup()` in the `finally` block via `git worktree remove`. The branch remains on the remote for PR review.
2. **DB Record**: `crew.status` = `complete`, retained for `crew_retention_days` (default 7 days).
3. **Mission**: Set to `completed` (or `pending-review` if PR review is configured).
4. **Research Cargo**: Written to `~/.fleet/starbases/starbase-{id}/cargo/{sector_id}/{mission_id}/` as `full-output.md` and `summary.md`. Cargo DB records point to these files.
5. **Ships Log**: `exited` event recorded.
6. **Comms**: `mission_complete` transmission sent to admiral.
7. **Temp Files**: Prompt and system-prompt files deleted from `/tmp/fleet-prompts/`.

### What listCrew() Shows

```typescript
// crew-service.ts:239
let sql = "SELECT * FROM crew WHERE status IN ('active', 'complete', 'error', 'timeout')";
```

`dismissed` crew are intentionally excluded from list output — they have been acknowledged and cleared by the operator. `lost` and `aborted` are also excluded (internal states).

### Storage Growth Over Time

Without intervention, the DB will accumulate:
- One crew record per deployed agent (small, ~1 KB each)
- One or more comms records per crew (small, bounded by rate limiter)
- Ships log events (small, text)
- Cargo records + files (potentially large for research missions — full output can be 50 KB+)

The worktree directories are the largest storage consumers. At the default 5 GB disk budget (`worktree_disk_budget_gb`), the Sentinel alerts at 90% usage. Worktrees are cleaned up on completion, so disk pressure only builds when many crews are running concurrently or worktrees are stuck (push-pending).

---

## 3. Best Practices from Industry

### Agent/Worker Lifecycle Patterns

**Short-lived workers (Lambda, Kubernetes Jobs):** Resources are released immediately on completion. State is preserved in external storage (S3, DB). This is Fleet's model — worktrees are ephemeral, state lives in SQLite.

**Retry with backoff:** Failed workers trigger retries with exponential backoff. Fleet implements this via First Officer for `failed` and `failed-verification` missions (up to `first_officer_max_retries`, default 3).

**Soft-delete before hard-delete:** Systems like GitHub Issues, Jira, and Kubernetes use a `completed`/`terminated` state before permanent deletion to allow post-mortem inspection. This is exactly what Fleet does with `dismissed` → retention window → hard delete.

**Retention policies over immediate deletion:** Audit trails are valuable. Kubernetes keeps terminated pod records for a configurable period. Fleet keeps `crew_retention_days` (default 7) which is a reasonable default for active development teams.

**Separate log retention from record retention:** Logs are typically kept longer than operational records. Fleet correctly separates `ships_log_retention_days` (30) from `crew_retention_days` (7), so the audit trail outlives the crew record.

**Background cleanup jobs:** Don't block the hot path on cleanup. Fleet uses a retention service run as a batch cleanup rather than cleaning up inline during deployment.

---

## 4. Implementation Options

### Option A: Automatic Removal After N Minutes of Completion

**What it would look like:**

Add a scheduled sweep in Sentinel that auto-recalls completed crew after a configurable idle period (e.g., 30 minutes):

```typescript
// In sentinel._runSweep():
const autoRecallMin = configService.get('auto_recall_after_min') as number ?? 30;
const staleCompleted = db.prepare(`
  SELECT id FROM crew
  WHERE status IN ('complete', 'error', 'timeout')
  AND updated_at < datetime('now', '-${autoRecallMin} minutes')
`).all() as { id: string }[];

for (const crew of staleCompleted) {
  crewService.recallCrew(crew.id); // sets status to 'dismissed'
}
```

**Trade-offs:**

| Pro | Con |
|-----|-----|
| Keeps UI clean automatically | Operator may miss a completed crew before it's dismissed |
| Prevents completed crew from cluttering `fleet crew list` | Loses the ability to `fleet crew observe <id>` for recent output |
| Consistent with ephemeral agent philosophy | Requires a new config key and Sentinel coupling |
| Reduces DB row count over time | 30 minutes may be too short for slow reviewers |

**When to use:** High-volume starbase with many concurrent crews where UI noise from completed crews is a problem.

---

### Option B: Manual `fleet crew recall` with Archive Before Deletion

**What it would look like:**

Enhance `recallCrew()` to write an archive file before dismissing:

```typescript
recallCrew(crewId: string, opts?: { archive?: boolean }): void {
  // Existing kill logic...

  if (opts?.archive) {
    const row = db.prepare('SELECT * FROM crew WHERE id = ?').get(crewId) as CrewRow;
    const archiveDir = join(homePath, '.fleet', 'starbases', `starbase-${starbaseId}`, 'archives');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, `${crewId}-${Date.now()}.json`);
    writeFileSync(archivePath, JSON.stringify(row, null, 2));
  }

  db.prepare("UPDATE crew SET status = 'dismissed' ...").run(crewId);
}
```

Add a CLI alias:

```bash
fleet crew archive <crew-id>   # recall + write archive JSON
```

**Trade-offs:**

| Pro | Con |
|-----|-----|
| Explicit operator control — nothing disappears without intention | Requires operator action for each crew |
| Archive files survive DB retention window | Archive directory grows unbounded without its own cleanup |
| Full crew state preserved for post-mortem | More operator work in high-volume setups |
| Easy to implement without changing existing flow | Not scalable beyond a few dozen missions/day |

**When to use:** Low-volume starbase where operators want full control and auditability.

---

### Option C: Soft-Delete with Retention Window Before Hard-Delete (Current Approach — Recommended)

**Current behavior:** This is already implemented. Completed crew sit in terminal status (`complete`, `error`, `timeout`) until explicitly recalled (`dismissed`), then are hard-deleted after `crew_retention_days`.

**The full flow:**

```
crew completes
      ↓
status = 'complete'  (visible in fleet crew list)
      ↓
operator runs: fleet crew recall <crew-id>
      ↓
status = 'dismissed'  (hidden from fleet crew list)
      ↓
RetentionService.cleanup() runs (daily or on demand)
      ↓
DELETE FROM crew WHERE status = 'dismissed' AND updated_at < 7 days ago
```

**Improving the current approach:**

1. **Schedule retention cleanup automatically** (not yet implemented — currently must be triggered manually):

```typescript
// In index.ts startup, schedule daily retention cleanup:
setInterval(() => {
  const result = retentionService.cleanup();
  console.log('[retention] Cleaned:', result);
  retentionService.vacuum();
}, 24 * 60 * 60 * 1000); // once per day
```

2. **Add `fleet retention run` CLI command** (if not present) to allow on-demand cleanup:

```bash
fleet retention run    # triggers RetentionService.cleanup() + VACUUM
fleet retention stats  # shows table counts and DB size
```

3. **Auto-dismiss completed crew after review** — once a PR is merged/approved and mission is `completed`, auto-dismiss the crew since there is no further use for the record:

```typescript
// In sentinel.reviewSweep(), after auto-approved missions transition:
db.prepare("UPDATE crew SET status = 'dismissed' WHERE id IN (SELECT crew_id FROM missions WHERE status = 'completed' AND completed_at < datetime('now', '-1 hour'))").run();
```

**Trade-offs:**

| Pro | Con |
|-----|-----|
| Already implemented — no new code needed | Completed crew accumulate in UI until manually recalled |
| Operator has full visibility window before deletion | `fleet crew list` gets cluttered on busy days |
| Audit trail survives for 7 days | Requires manual recall step for cleanup |
| Configurable retention window per operator preference | Retention cleanup isn't scheduled automatically yet |

**When to use:** This is the correct default for most Fleet deployments. Tune `crew_retention_days` down to 1-3 days for high-volume setups.

---

### Option D: Dismiss-on-Completion (Aggressive Auto-Recall)

**What it would look like:**

Modify `Hull.cleanup()` to automatically set `status = 'dismissed'` instead of `status = 'complete'` when a crew finishes without errors:

```typescript
// In hull.ts cleanup() finally block:
const finalStatus = status === 'complete' ? 'dismissed' : (overrideStatus ?? status);
db.prepare("UPDATE crew SET status = ?, updated_at = datetime('now') WHERE id = ?")
  .run(finalStatus, crewId);
```

**Trade-offs:**

| Pro | Con |
|-----|-----|
| Zero UI clutter — completed crew vanish immediately | Cannot `fleet crew observe <id>` after completion |
| Retention cleanup happens faster | Harder to diagnose issues post-completion |
| Minimal DB growth | Mission record still exists — crew context requires join |
| Zero operator work | Counter-intuitive for operators expecting to see crew status |

**When to use:** Not recommended for general use. Only consider for fully automated pipelines where humans never inspect crew state.

---

## 5. Recommendations

### Recommended Approach: Enhance Option C (Current Soft-Delete)

The existing implementation is sound. The primary gap is that **retention cleanup is not automatically scheduled** and **completed crew pile up in the UI**.

#### Immediate wins (no architectural change needed):

1. **Schedule `RetentionService.cleanup()` daily at startup** — add a `setInterval` in `index.ts` to run retention cleanup once per 24 hours. This prevents indefinite DB growth.

2. **Lower the default `crew_retention_days` from 7 to 3** — a week is long for fast-moving teams. 3 days is enough to review completed work and debug failures.

3. **Auto-dismiss when mission reaches `completed`** — after the Sentinel transitions `approved` → `completed`, immediately dismiss the associated crew. The operator has already reviewed and approved, so the crew record has no further purpose.

#### Medium-term improvements:

4. **Add `fleet crew clean` command** — batch-dismiss all crews in terminal statuses:
   ```bash
   fleet crew clean              # dismiss all complete/error/timeout crews
   fleet crew clean --status error   # dismiss only errored crews
   fleet crew clean --sector my-api  # dismiss crews for a specific sector
   ```

5. **Surface retention stats in Star Command UI** — show DB size and row counts in the settings panel so operators know when cleanup is needed.

6. **Auto-dismiss after configurable idle window** — add `auto_dismiss_after_min` config key (default: 60 minutes) that Sentinel uses to auto-dismiss terminal crew. Combine with Option A's sweep logic.

### Configuration Reference

```bash
# Adjust retention windows
fleet config set crew_retention_days 3       # default: 7
fleet config set comms_retention_days 14     # default: 30
fleet config set cargo_retention_days 7      # default: 14
fleet config set ships_log_retention_days 14 # default: 30
```

### Current CLI Commands for Crew Cleanup

```bash
# Recall (dismiss) a specific crew
fleet crew recall <crew-id>

# List current crew (shows active, complete, error, timeout — not dismissed)
fleet crew list

# Observe crew output (only works while hull is in memory)
fleet crew observe <crew-id>

# Check retention stats
fleet retention stats

# Run retention cleanup manually
fleet retention run
```

### Storage Considerations at Scale

| Scenario | Storage Impact |
|----------|----------------|
| 10 crews/day × 7 day retention | ~70 crew records, negligible DB size |
| 10 research crews/day × 14 day cargo retention | ~140 cargo files × ~50 KB each = ~7 MB |
| Worktrees (transient) | Cleaned up on completion — not a retention concern |
| 100 crews/day | Consider lowering `crew_retention_days` to 1-2 days |

The SQLite DB is typically tiny (<10 MB) even after months of operation. The main storage concern is research cargo files, which can be 50 KB–1 MB each depending on output length.

---

## Summary

| Layer | Trigger | What It Removes | When |
|-------|---------|-----------------|------|
| `Hull.cleanup()` | Claude process exits | Worktree, temp files | Immediately on completion |
| `recallCrew()` | `fleet crew recall` | Hull process, sets `dismissed` | On operator command |
| `Reconciliation` | App startup | Orphaned worktrees, dead PIDs | Once on boot |
| `RetentionService` | Manual / scheduled | DB records (crew, comms, cargo, logs) | On demand / daily |

The design is correct: **worktrees are ephemeral, records are retained for auditing, and hard-deletion is deferred**. The main missing piece is automatic scheduling of the retention cleanup sweep.
