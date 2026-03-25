# Ships Log Coverage Design

**Date:** 2026-03-24
**Goal:** Ensure all four Star Command roles (Sentinel, First Officer, Navigator, Analyst) log their significant activities through the `ShipsLog` class, replacing raw SQL inserts and adding missing event coverage.

## Problem

1. **Sentinel and First Officer** bypass `ShipsLog`, using raw `INSERT INTO ships_log` SQL — fragile, inconsistent, and bypasses any future logging enhancements.
2. **Navigator and Analyst** log nothing to ships_log at all.
3. Several Sentinel and First Officer activities write to `comms` but not to ships_log.

## Design

### Approach: Inject `ShipsLog` as a dependency

Each role class gains a `shipsLog` field in its deps type. All raw SQL inserts into `ships_log` are replaced with `shipsLog.log(...)`. Navigator and Analyst gain new log calls at each significant activity.

No SQLite schema changes needed — the existing `ships_log` table and `ShipsLog` class API are sufficient. The deps types for all four roles gain a new `shipsLog` field.

### Error handling

All `shipsLog.log()` calls are fire-and-forget — wrap in try/catch and swallow failures. Logging must never block primary operations (crew deployment, escalation, triage decisions). This matches the existing pattern where raw SQL inserts have no error handling but are non-critical side effects.

### Dependency optionality

- **Sentinel, First Officer:** `shipsLog` is **required** in deps (these roles always run inside the full starbase runtime where ShipsLog is available).
- **Navigator, Analyst:** `shipsLog` is **optional** (`shipsLog?: ShipsLog`) since these are sometimes instantiated in tests or lightweight contexts. Guard with `this.shipsLog?.log(...)`.

### Sentinel — migrate 8 existing + add 5 new events

**Existing (migrate from raw SQL to ShipsLog):**

| Event Type | Location | crew_id | Notes |
|---|---|---|---|
| `lifesign_lost` | `_runSweep()` — stale crew detected | yes | |
| `timeout` | `_runSweep()` — deadline expired | yes | |
| `sector_path_missing` | `_runSweep()` — sector path inaccessible | no | |
| `socket_restart` | `checkSocketHealth()` — 3 consecutive ping failures | no | |
| `first_officer_dispatched` | `firstOfficerSweep()` — inside onExit callback | yes | Logged when FO process exits, not on dispatch. Name is legacy — keep for backward compat. |
| `review_crew_dispatched` | `reviewSweep()` — review crew deployed | no | |
| `review_escalated` | `reviewSweep()` — max review rounds reached | no | |
| `fix_crew_dispatched` | `reviewSweep()` — fix crew deployed | no | |

**New events to add:**

| Event Type | Location | crew_id | Detail | Notes |
|---|---|---|---|---|
| `disk_warning` | `_runSweep()` step 5 | no | `{ usedGb, budgetGb, percent }` | Only log when `lastAlertLevel` changes (same dedup guard as comms) |
| `memory_warning` | `_runSweep()` step 6 | no | `{ freeMemoryGb, level }` | Only log when `lastAlertLevel` changes (same dedup guard as comms) |
| `gate_expired` | `navigatorSweep()` | no | `{ executionId, protocolId }` | |
| `navigator_fan_out_failed` | `navigatorSweep()` — crew-failed fan-out dispatches navigator | no | `{ executionId, protocolSlug, step }` | Logged by Sentinel on behalf of Navigator |
| `navigator_fan_out_completed` | `navigatorSweep()` — crew-completed fan-out dispatches navigator | no | `{ executionId, missionId }` | Logged by Sentinel on behalf of Navigator |

### First Officer — migrate 3 existing + add 2 new events

**Existing (migrate from raw SQL to ShipsLog):**

| Event Type | Location | crew_id |
|---|---|---|
| `first_officer_retried` | `resolveRetry()` | yes |
| `first_officer_recovered` | `resolveRecovery()` | yes |
| `first_officer_dismissed` | `resolveEscalation()` | yes |

**New events to add:**

| Event Type | Location | crew_id | Detail |
|---|---|---|---|
| `hailing_memo_written` | `writeHailingMemo()` | yes | `{ missionId, sectorName }` |
| `auto_escalation` | `writeAutoEscalationComm()` | yes | `{ missionId, classification, fingerprint }` |

Note: `writeAutoEscalationComm()` is called from the Sentinel's `firstOfficerSweep()` path (via circuit-breaker logic when persistent/non-retryable errors are detected before FO dispatch). The log call lives inside the First Officer class method itself.

### Navigator — add 4 new events

| Event Type | Location | crew_id | Detail |
|---|---|---|---|
| `navigator_dispatched` | `dispatch()` — after process spawned successfully | no | `{ executionId, protocolSlug, step }` |
| `navigator_completed` | `dispatch()` — exit handler, code === 0 | no | `{ executionId, protocolSlug }` |
| `navigator_failed` | `dispatch()` — exit handler, code !== 0, or `error` event | no | `{ executionId, protocolSlug, reason }` |
| `navigator_timeout` | `dispatch()` — killed by timeout timer | no | `{ executionId, protocolSlug }` |

**Dependency injection:** Add `shipsLog?: ShipsLog` to `NavigatorDeps`.

**Timeout tracking:** Add a `timedOut` Set to track which execution IDs were killed by timeout, so the `exit` handler can distinguish timeout from crash and log the correct event type.

### Analyst — add 5 new events

| Event Type | Location | crew_id | Detail |
|---|---|---|---|
| `analyst_classified` | `classifyError()` — success | no | `{ classification, method: 'classifyError' }` |
| `analyst_summarized` | `summarizeCILogs()` — success | no | `{ method: 'summarizeCILogs' }` |
| `analyst_verdict_extracted` | `extractPRVerdict()` — success | no | `{ verdict, method: 'extractPRVerdict' }` |
| `analyst_hailing_context` | `writeHailingContext()` — success | no | `{ method: 'writeHailingContext' }` |
| `analyst_degraded` | `writeDegradedComm()` — method failed | no | `{ method, reason }` |

**Dependency injection:** Add `shipsLog?: ShipsLog` to `AnalystDeps`. Guard all log calls with `this.shipsLog?.log(...)`.

### Wiring

In `starbase-runtime-core.ts`, the `ShipsLog` instance is already created. Pass it into all four roles:
- `Sentinel` deps — required `shipsLog: ShipsLog`
- `FirstOfficer` deps — required `shipsLog: ShipsLog`
- `Navigator` deps — optional `shipsLog?: ShipsLog`
- `Analyst` deps — optional `shipsLog?: ShipsLog`

### Testing

Each role's existing test file gets new assertions:
- **Sentinel tests:** verify `ShipsLog` calls replace raw SQL for all 8 existing events, plus 5 new events are logged. Assert no raw `INSERT INTO ships_log` SQL remains in migrated code paths (grep guard).
- **First Officer tests:** verify `ShipsLog` calls replace raw SQL for 3 existing events, plus hailing memo and auto-escalation events. Assert no raw `INSERT INTO ships_log` SQL remains.
- **Navigator tests:** verify dispatched/completed/failed/timeout events are logged with correct event types and details.
- **Analyst tests:** verify each method logs on success and `analyst_degraded` is logged on failure.

Use a `ShipsLog` instance backed by an in-memory SQLite DB (already the pattern in `ships-log.test.ts`).

## Event Type Summary

Total: **27 event types** across 4 roles.

| Role | Migrated | New | Total |
|---|---|---|---|
| Sentinel | 8 | 5 | 13 |
| First Officer | 3 | 2 | 5 |
| Navigator | 0 | 4 | 4 |
| Analyst | 0 | 5 | 5 |
