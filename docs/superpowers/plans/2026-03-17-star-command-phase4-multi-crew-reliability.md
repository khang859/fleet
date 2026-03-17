# Star Command Phase 4: Multi-Crew + Reliability — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run multiple Crewmates concurrently with failure detection (Sentinel), crash recovery (reconciliation), worktree coordination (limits + pool), merge conflict handling, and PR creation.

**Architecture:** Sentinel runs a 10-second sweep detecting stale Lifesigns, expired deadlines, and resource issues. Reconciliation runs on startup to recover from crashes. WorktreeManager enforces concurrency limits and pools worktrees. Hull handles rebase + PR creation after push.

**Tech Stack:** existing StarbaseDB + services, child_process (for git/gh), os module (for system checks)

**Spec:** `docs/superpowers/specs/2026-03-17-star-command-phase4-multi-crew-reliability.md`

---

## File Structure

**New files:**
- `src/main/starbase/sentinel.ts` — Watchdog sweep: Lifesigns, deadlines, disk, memory
- `src/main/starbase/reconciliation.ts` — Startup crash recovery
- `src/main/starbase/ships-log.ts` — Ship's Log service
- `src/main/starbase/lockfile.ts` — Duplicate instance lockfile
- `src/main/__tests__/sentinel.test.ts`
- `src/main/__tests__/reconciliation.test.ts`
- `src/main/__tests__/ships-log.test.ts`
- `src/main/__tests__/lockfile.test.ts`

**Modified files:**
- `src/main/starbase/worktree-manager.ts` — Add concurrency limits, worktree pool, recycling
- `src/main/starbase/hull.ts` — Add rebase handling, PR creation, merge strategy execution
- `src/main/starbase/crew-service.ts` — Auto-deploy on free slot, queue when at limit
- `src/main/starbase/comms-service.ts` — Rate limiting
- `src/main/starbase/migrations.ts` — Add migration 002 for `comms_count_minute` column
- `src/main/index.ts` — Initialize Sentinel, run reconciliation on startup

---

## Chunk 1: Ship's Log + Lockfile

### Task 1: Write Ship's Log service

**Files:**
- Create: `src/main/starbase/ships-log.ts`
- Create: `src/main/__tests__/ships-log.test.ts`

- [ ] **Step 1: Write failing tests**

Test: log an event, query by crewId, query by eventType, getRecent.

- [ ] **Step 2: Write implementation**

Simple wrapper around `ships_log` table: `log()`, `query()`, `getRecent()`.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add Ship's Log service for audit trail"
```

---

### Task 2: Write Lockfile

**Files:**
- Create: `src/main/starbase/lockfile.ts`
- Create: `src/main/__tests__/lockfile.test.ts`

- [ ] **Step 1: Write failing tests**

Test: acquire lock, detect stale lock (dead PID), detect active lock (live PID), release on close.

- [ ] **Step 2: Write implementation**

Write `{ pid, timestamp }` JSON to `starbase-{id}.lock`. Check PID alive via `process.kill(pid, 0)`. Stale if PID dead or lock > 24 hours old.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add lockfile for duplicate instance detection"
```

---

## Chunk 2: Sentinel

### Task 3: Write Sentinel watchdog

**Files:**
- Create: `src/main/starbase/sentinel.ts`
- Create: `src/main/__tests__/sentinel.test.ts`

- [ ] **Step 1: Write failing tests**

Test scenarios:
- Stale Lifesign → crew marked "lost"
- Expired deadline → crew terminated
- Missing Sector path → Sector disabled
- Disk usage warning at 90%
- Rate limit counter reset every 6th sweep

- [ ] **Step 2: Write Sentinel implementation**

Class with `start()`, `stop()`, `runSweep()`. Sweep runs 7 checks as described in spec. Uses `du -sk` for disk (cached 60s), `os.freemem()` for memory.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add Sentinel watchdog for failure detection"
```

---

## Chunk 3: Reconciliation

### Task 4: Write startup reconciliation

**Files:**
- Create: `src/main/starbase/reconciliation.ts`
- Create: `src/main/__tests__/reconciliation.test.ts`

- [ ] **Step 1: Write failing tests**

Test scenarios:
- Active crew with dead PID → marked "lost"
- Active crew with PID alive but > 24h old → treated as stale
- Orphaned worktree directories → cleaned up
- Push-pending missions → push retried
- Active missions with lost crew → reset to queued

- [ ] **Step 2: Write reconciliation implementation**

`runReconciliation()` function that executes the 9-step sequence from the spec. Returns a summary object.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add startup reconciliation for crash recovery"
```

---

## Chunk 4: Worktree Limits + Pool

### Task 5: Add concurrency limits and worktree pool to WorktreeManager

**Files:**
- Modify: `src/main/starbase/worktree-manager.ts`
- Modify: `src/main/starbase/migrations.ts` — add migration 002
- Modify: `src/main/__tests__/worktree-manager.test.ts`

- [ ] **Step 1: Add migration 002 for pool_status and comms_count_minute**

In `migrations.ts`, add migration version 2:

```sql
ALTER TABLE crew ADD COLUMN pool_status TEXT;
ALTER TABLE crew ADD COLUMN pooled_at DATETIME;
ALTER TABLE crew ADD COLUMN comms_count_minute INTEGER DEFAULT 0;
```

- [ ] **Step 2: Add `WorktreeLimitError` throw when at max**

`create()` checks count of active worktrees in crew table. If >= `max_concurrent_worktrees`, throw `WorktreeLimitError`.

- [ ] **Step 3: Add `recycle()`, `getPooled()`, `evictStale()`**

Pool tracking via crew table `pool_status` column.

- [ ] **Step 4: Update `create()` to check pool first**

Before creating a fresh worktree, check for pooled worktrees to reuse.

- [ ] **Step 5: Write tests for new functionality**
- [ ] **Step 6: Run tests, verify pass**
- [ ] **Step 7: Commit**

```bash
git commit -m "feat(starbase): add worktree concurrency limits and recycling pool"
```

---

## Chunk 5: Merge Conflicts + PR Creation

### Task 6: Add rebase handling and PR creation to Hull

**Files:**
- Modify: `src/main/starbase/hull.ts`

- [ ] **Step 1: Add rebase logic after push**

In Hull's cleanup, after pushing: check if base branch moved, attempt rebase, use `--force-with-lease` on success, create draft PR on conflict.

- [ ] **Step 2: Add PR creation with merge strategy**

Read `merge_strategy` from sector. Execute: `gh pr create` for "pr", `gh pr merge --auto` for "auto-merge", skip for "branch-only". Cache `gh` availability. Handle auth failures with fallback.

- [ ] **Step 3: Write tests for rebase and PR paths**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add rebase handling and PR creation to Hull"
```

---

## Chunk 6: Auto-Deploy + Rate Limiting + Integration

### Task 7: Add auto-deploy on free slot and comms rate limiting

**Files:**
- Modify: `src/main/starbase/crew-service.ts`
- Modify: `src/main/starbase/comms-service.ts`

- [ ] **Step 1: CrewService catches WorktreeLimitError, queues mission**
- [ ] **Step 2: After Hull completion, check for queued missions and auto-deploy**
- [ ] **Step 3: CommsService checks rate before sending**
- [ ] **Step 4: Write tests**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(starbase): add auto-deploy on free slot and comms rate limiting"
```

---

### Task 8: Wire Sentinel and reconciliation into main process

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Run reconciliation on app startup after StarbaseDB opens**
- [ ] **Step 2: Start Sentinel after reconciliation completes**
- [ ] **Step 3: Stop Sentinel on app quit**
- [ ] **Step 4: Acquire lockfile on startup, release on quit**
- [ ] **Step 5: Run typecheck and all tests**

```bash
cd /Users/khangnguyen/Development/fleet && npm run typecheck && npm test
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(starbase): wire Sentinel, reconciliation, and lockfile into main process"
```
