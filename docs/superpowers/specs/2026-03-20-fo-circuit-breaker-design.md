# First Officer Circuit Breaker Design

**Date:** 2026-03-20
**Status:** Draft
**Problem:** The First Officer (FO) and review cycle create circular retry loops — the FO keeps retrying unfixable errors, review agents spawn repeatedly, and the system burns resources with no progress.

## Root Causes

1. **FO lacks historical context** — Each FO invocation only sees the current failure output. It has no visibility into what previous attempts tried or decided, so it makes the same retry decision repeatedly.
2. **No global retry budget** — `first_officer_retry_count` (max 3) and `review_round` (max 2) are independent counters. A mission can bounce between the FO retry cycle and the review cycle, producing up to ~9 agent deployments.
3. **Multiple errored crews trigger parallel FO dispatches** — The sentinel query can return multiple errored crew records for the same mission, each triggering a separate FO dispatch.
4. **FO dispatch blocks the UI** — The sentinel `await`s `firstOfficer.dispatch()` inline, blocking the sweep loop and event bus emissions during process startup.
5. **Memos are a separate system from comms** — The Admiral must check two inboxes. Memos should be comms.

## Design

### 1. Error Classifier

Add an error classifier to the sentinel's `firstOfficerSweep()`, evaluated **before** FO dispatch. Classification uses data already in the DB (`missions.result`, `missions.verify_result`) — no LLM call.

**Categories:**

| Category        | Detection                                      | Action                          | Examples                                                                  |
| --------------- | ---------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `transient`     | Default; fingerprint differs from last attempt | Dispatch FO (bounded by budget) | Timeout, OOM, crash, lifesign lost                                        |
| `persistent`    | Same `error_fingerprint` as previous attempt   | Auto-escalate, skip FO          | Same test failing repeatedly                                              |
| `non-retryable` | Pattern match on error output                  | Auto-escalate immediately       | `ENOENT`, `EACCES`, `MODULE_NOT_FOUND`, `401`, `403`, `config.*not found` |

**Pattern matching implementation:** Simple regex array scanned against `missions.result` + `missions.verify_result`. Not exhaustive — unknown errors default to `transient` and the fingerprint catches repetition on the next failure.

```typescript
const NON_RETRYABLE_PATTERNS = [
  /ENOENT|EACCES|EPERM/,
  /MODULE_NOT_FOUND|Cannot find module/,
  /401|403|Unauthorized|Forbidden/,
  /config.*not found|missing.*configuration/i,
  /no such file or directory/i
];
```

### 2. Fingerprint Tracking

New column on `missions`: `last_error_fingerprint TEXT`.

Computed by:

1. Take last 50 lines of crew output (`missions.result`) + verify stderr (`missions.verify_result`)
2. Strip variable parts: timestamps, PIDs, memory addresses, absolute file paths with hashes
3. SHA-256 hash, truncated to 16 hex chars

The sentinel stores the fingerprint on each failure. On subsequent failures for the same mission:

- **Same fingerprint** → classify as `persistent`, auto-escalate
- **Different fingerprint** → new failure mode, allow FO triage

This makes repetition detection **structural** (orchestration layer) rather than relying on the LLM to remember.

### 3. Global Mission Budget

New column on `missions`: `mission_deployment_count INTEGER DEFAULT 0`.

Incremented in `crewService.deployCrew()` every time ANY crew is deployed for that mission — code crews, fix crews, review crews, FO-initiated retries.

The sentinel checks before any dispatch:

```
if mission_deployment_count >= max_mission_deployments → auto-escalate
```

**Default: 6.** Configurable via `config_service` key `max_mission_deployments`. This is the hard ceiling that prevents combinatorial explosion between FO retries and review rounds. The existing `first_officer_retry_count` and `review_round` counters remain for their specific logic.

Rough budget breakdown for a worst-case mission: initial crew (1) + 2 FO retries (2) + 2 review crews (2) + 2 fix crews (2) + 1 buffer = 9. **Default: 8.** This allows a full FO retry cycle + full review cycle without premature escalation. Review-type crews count toward the same budget — they're still compute and tokens being spent.

`mission_deployment_count` is **intentionally sticky** — it does NOT reset on `resetForRequeue()`. This counter tracks total resources spent on a mission regardless of how it was re-queued. If the Admiral manually cancels and creates a new mission, that's a fresh mission with a fresh counter. But re-queuing the same mission (whether via FO retry or manual `fleet missions update --status queued`) preserves the budget history.

Similarly, `first_officer_retry_count` remains sticky across re-queues — it does NOT reset in `resetForRequeue()`. This is intentional: the FO retry count and the global budget are both hard ceilings that accumulate across the mission's lifetime. The effective FO retry limit for a mission is `min(first_officer_max_retries, remaining global budget)`.

The `mission_deployment_count` increment is placed **after successful worktree creation** in `deployCrew()` — deploy failures due to memory pressure or worktree limits do not consume budget slots since no agent actually ran.

### 4. FO Dispatch Changes

#### 4a. Async Fire-and-Forget

The sentinel's `firstOfficerSweep()` no longer `await`s `dispatch()`. Instead, dispatch is fire-and-forget. This unblocks the sweep loop and prevents UI freezes.

**Retry count increment strategy:** The sentinel increments `first_officer_retry_count` **synchronously before dispatch** (not after). This prevents the race where the next sweep re-dispatches the same mission before the FO exits. If the dispatch itself fails (spawn error), the count is still incremented — this is conservative (wastes one retry slot) but safe.

The `dispatch()` method gains an `onExit` callback parameter for ships_log entries and comms writes that happen after the FO process completes.

```typescript
// Before (blocks sweep):
const dispatched = await firstOfficer.dispatch(event)
if (dispatched) { /* increment, log */ }

// After (non-blocking):
// Increment BEFORE dispatch to prevent race
db.prepare('UPDATE missions SET first_officer_retry_count = first_officer_retry_count + 1 WHERE id = ?')
  .run(row.mid)

firstOfficer.dispatch(event, {
  onExit: (code) => {
    db.prepare("INSERT INTO ships_log ...").run(...)
  }
}).catch(err => {
  console.error('[sentinel] FO dispatch error:', err)
})
```

The `isRunning()` dedup check still prevents double-dispatch within the same sweep. The pre-incremented retry count prevents re-dispatch on subsequent sweeps.

#### 4b. Compact Attempt History in Prompt

Before spawning, query comms for previous memo-type entries for this mission. Build a compact summary table (not full memo contents) appended to the FO's initial message:

```markdown
## Previous Attempts

| #   | Action                               | Error Fingerprint       | Outcome           |
| --- | ------------------------------------ | ----------------------- | ----------------- |
| 1   | RETRY: narrowed scope to auth module | a3f2b1c9 (test timeout) | Same test timeout |
| 2   | RETRY: added explicit timeout config | a3f2b1c9 (test timeout) | Same test timeout |
```

Built from comms payload data + fingerprint. Max ~10 lines regardless of attempt count. If the FO needs full details, it can `fleet missions show <id>` or read memo files directly.

#### 4c. Mandatory Retry Memo

Update the FO's CLAUDE.md: when choosing RETRY, the FO **must also** write a short memo to `./memos/` documenting:

- What it analyzed
- What action it took (the revised prompt or scope change)
- Why it expects the retry to succeed

This serves two purposes:

1. **Audit trail** — feeds into 4b for the next FO attempt
2. **Dedup guard** — the comms entry prevents double-dispatch while the retry is in flight

#### 4d. Model Change

Default `first_officer_model` changes from `claude-sonnet-4-6` to `claude-haiku-4-5`. The FO's task is narrow (analyze error, decide retry/escalate, run 2-3 CLI commands) and doesn't require Sonnet-level reasoning. Faster and cheaper. Still configurable via `config_service`.

### 5. Sentinel Query Dedup

The `firstOfficerSweep()` query adds a subquery to pick only the most recent crew per mission:

```sql
WHERE c.id = (
  SELECT c2.id FROM crew c2
  WHERE c2.mission_id = m.id
    AND c2.status IN ('error', 'lost', 'timeout')
  ORDER BY c2.updated_at DESC
  LIMIT 1
)
```

This ensures exactly one FO dispatch per failed mission per sweep, regardless of how many historical crew records exist.

### 6. Memos → Comms

**Drop the `memos` table.** Escalation and retry memos become comms entries:

```
comms row:
  from_crew: 'first-officer'
  to_crew: 'admiral'
  type: 'memo'
  payload: JSON {
    missionId,
    crewId,
    eventType,
    summary: "Max retries exhausted — test timeout persists after 3 attempts",
    filePath: "/path/to/full/memo.md",
    retryCount,
    fingerprint,
    classification: "persistent"
  }
```

Full memo markdown files still get written to disk for detailed context. The comms entry carries a short summary + file path pointer.

**Changes:**

- Add `mission_id INTEGER` column to `comms` table (nullable FK to missions) — used for efficient dedup queries instead of JSON LIKE scanning
- `firstOfficer.writeEscalationMemo()` and `scanForNewMemos()` insert comms rows instead of memos rows
- `firstOfficer.writeHailingMemo()` also migrates to comms: `type = 'hailing-memo'`, same payload structure. The sentinel's hailing dedup guard (`sentinel.ts:376-381`) switches from memos to: `NOT EXISTS (SELECT 1 FROM comms WHERE type = 'hailing-memo' AND mission_id = cr.mission_id AND read = 0)` — note: the hailing query context uses `cr` (crew alias), not `m`, and `cr.mission_id` can be NULL so the outer query should add `AND cr.mission_id IS NOT NULL`
- `hull.ts:623` review escalation writes migrate from `INSERT INTO memos` to `INSERT INTO comms` with `type = 'memo'`, `from_crew = 'first-officer'`, using the new `mission_id` column
- Sentinel dedup query: `NOT EXISTS (SELECT 1 FROM comms WHERE type = 'memo' AND mission_id = m.id AND read = 0)` — proper indexed FK lookup, no JSON LIKE
- `FirstOfficer.getStatus()` replaces `memoService.getUnreadCount()` with a direct DB query: `SELECT COUNT(*) FROM comms WHERE type IN ('memo', 'hailing-memo') AND to_crew = 'admiral' AND read = 0`
- Update Admiral workspace templates (`workspace-templates.ts`) to explain `memo` type comms: "These are escalation reports from the First Officer. Read the summary; for full details, read the file at `filePath`."
- UI `MemoPanel` reads from comms where `type IN ('memo', 'hailing-memo')`
- IPC handlers (`ipc-handlers.ts`) replace `memoList`, `memoRead`, `memoDismiss` with comms-based equivalents querying `type IN ('memo', 'hailing-memo')`
- Preload API surface updated to match new IPC handler names
- Drop `memos` table in a new migration
- Remove `MemoService` (CRUD replaced by comms queries)
- Remove `first_officer_retry_count` column reference from memo-specific logic (retry count tracked in comms payload)

## Database Migration

```sql
-- Add new columns to missions
ALTER TABLE missions ADD COLUMN last_error_fingerprint TEXT;
ALTER TABLE missions ADD COLUMN mission_deployment_count INTEGER DEFAULT 0;

-- Add mission_id FK to comms for efficient memo dedup queries
ALTER TABLE comms ADD COLUMN mission_id INTEGER REFERENCES missions(id);

-- Drop memos table
DROP TABLE IF EXISTS memos;
```

Config additions:

```typescript
max_mission_deployments: 8,
first_officer_model: 'claude-haiku-4-5',  // changed from claude-sonnet-4-6
```

## Files to Modify

| File                                                     | Change                                                                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/starbase/sentinel.ts`                          | Error classifier, fingerprint computation, async dispatch, query dedup, comms-based dedup, global budget check                                                                          |
| `src/main/starbase/first-officer.ts`                     | `onExit` callback param, attempt history in prompt, mandatory retry memo in CLAUDE.md/system prompt, model default change, write comms instead of memos, `getStatus()` uses comms query |
| `src/main/starbase/hull.ts`                              | Migrate review escalation write at line 623 from `INSERT INTO memos` to `INSERT INTO comms` with `type = 'memo'` and `mission_id` column                                                |
| `src/main/starbase/crew-service.ts`                      | Increment `mission_deployment_count` in `deployCrew()`                                                                                                                                  |
| `src/main/starbase/migrations.ts`                        | New migration: add columns to missions, add `mission_id` to comms, drop memos table, update config defaults                                                                             |
| `src/main/starbase/memo-service.ts`                      | Delete file (replaced by comms queries)                                                                                                                                                 |
| `src/main/starbase/workspace-templates.ts`               | Update Admiral CLAUDE.md to explain `memo` type comms                                                                                                                                   |
| `src/main/ipc-handlers.ts`                               | Replace `memoList`, `memoRead`, `memoDismiss` handlers with comms-based equivalents                                                                                                     |
| `src/main/index.ts`                                      | Update FO dependency injection (remove MemoService, add DB access for comms queries)                                                                                                    |
| `src/preload/index.ts`                                   | Update preload API surface for renamed memo IPC calls                                                                                                                                   |
| `src/renderer/src/components/star-command/MemoPanel.tsx` | Read from comms instead of memos                                                                                                                                                        |
| `src/renderer/src/store/star-command-store.ts`           | Update memo-related state to use comms                                                                                                                                                  |
| `src/main/starbase/config-service.ts`                    | Add `max_mission_deployments` default                                                                                                                                                   |
| `src/main/__tests__/first-officer.test.ts`               | Update tests for new behavior                                                                                                                                                           |
| `src/main/__tests__/sentinel.test.ts`                    | Add tests for error classifier, fingerprint, dedup                                                                                                                                      |

## References

- [MatrixTrak: Agent Loop Prevention](https://matrixtrak.com/blog/agents-loop-forever-how-to-stop) — Fingerprint-based detection, error classification table, escalation payloads
- [StrongDM Attractor: Coding Agent Loop Spec](https://github.com/strongdm/attractor/blob/main/coding-agent-loop-spec.md) — Steering messages, loop detection windows
- [Augment Code: Why Multi-Agent LLM Systems Fail](https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them) — Coordination failures, circuit breakers, global budgets
- [MarkAICode: Fix AI Agent Looping](https://markaicode.com/fix-ai-agent-looping-autonomous-coding/) — Semantic similarity detection, reflection prompts, escalation patterns
