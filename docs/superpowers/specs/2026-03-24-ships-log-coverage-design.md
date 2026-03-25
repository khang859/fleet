# Ships Log Coverage Design

**Date:** 2026-03-24
**Goal:** Ensure all four Star Command roles (Sentinel, First Officer, Navigator, Analyst) log their significant activities through the `ShipsLog` class, replacing raw SQL inserts and adding missing event coverage.

## Problem

1. **Sentinel and First Officer** bypass `ShipsLog`, using raw `INSERT INTO ships_log` SQL — fragile, inconsistent, and bypasses any future logging enhancements.
2. **Navigator and Analyst** log nothing to ships_log at all.
3. Several Sentinel and First Officer activities write to `comms` but not to ships_log.

## Design

### Approach: Inject `ShipsLog` as a dependency

Each role class gains a `shipsLog` property (via its deps type). All raw SQL inserts into `ships_log` are replaced with `this.shipsLog.log(...)` or `this.deps.shipsLog.log(...)`. Navigator and Analyst gain new log calls at each significant activity.

No schema changes needed — the existing `ships_log` table and `ShipsLog` class API are sufficient.

### Sentinel — migrate 8 existing + add 5 new events

**Existing (migrate from raw SQL to ShipsLog):**

| Event Type | Location | crew_id |
|---|---|---|
| `lifesign_lost` | `_runSweep()` — stale crew detected | yes |
| `timeout` | `_runSweep()` — deadline expired | yes |
| `sector_path_missing` | `_runSweep()` — sector path inaccessible | no |
| `socket_restart` | `checkSocketHealth()` — 3 consecutive ping failures | no |
| `first_officer_dispatched` | `firstOfficerSweep()` — FO process exited | yes |
| `review_crew_dispatched` | `reviewSweep()` — review crew deployed | no |
| `review_escalated` | `reviewSweep()` — max review rounds reached | no |
| `fix_crew_dispatched` | `reviewSweep()` — fix crew deployed | no |

**New events to add:**

| Event Type | Location | crew_id | Detail |
|---|---|---|---|
| `disk_warning` | `_runSweep()` step 5 | no | `{ usedGb, budgetGb, percent }` |
| `memory_warning` | `_runSweep()` step 6 | no | `{ freeMemoryGb, level }` |
| `gate_expired` | `navigatorSweep()` | no | `{ executionId, protocolId }` |
| `navigator_fan_out_failed` | `navigatorSweep()` — crew-failed fan-out | no | `{ executionId, protocolSlug }` |
| `navigator_fan_out_completed` | `navigatorSweep()` — crew-completed fan-out | no | `{ executionId, missionId }` |

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

### Navigator — add 4 new events

| Event Type | Location | crew_id | Detail |
|---|---|---|---|
| `navigator_dispatched` | `dispatch()` — process spawned successfully | no | `{ executionId, protocolSlug, step }` |
| `navigator_completed` | `dispatch()` — exit code 0 | no | `{ executionId, protocolSlug }` |
| `navigator_failed` | `dispatch()` — exit code != 0 or spawn error | no | `{ executionId, protocolSlug, reason }` |
| `navigator_timeout` | `dispatch()` — killed by timeout | no | `{ executionId, protocolSlug }` |

**Dependency injection:** Add `shipsLog?: ShipsLog` to `NavigatorDeps`. The Navigator already has `db` but will use `ShipsLog` exclusively for logging.

**Timeout tracking:** Add a `timedOut` Set to track which execution IDs were killed by timeout, so the `exit` handler can distinguish timeout from crash.

### Analyst — add 5 new events

| Event Type | Location | crew_id | Detail |
|---|---|---|---|
| `analyst_classified` | `classifyError()` — success | no | `{ classification, method: 'classifyError' }` |
| `analyst_summarized` | `summarizeCILogs()` — success | no | `{ method: 'summarizeCILogs' }` |
| `analyst_verdict_extracted` | `extractPRVerdict()` — success | no | `{ verdict, method: 'extractPRVerdict' }` |
| `analyst_hailing_context` | `writeHailingContext()` — success | no | `{ method: 'writeHailingContext' }` |
| `analyst_degraded` | `writeDegradedComm()` — method failed | no | `{ method, reason }` |

**Dependency injection:** Add `shipsLog?: ShipsLog` to `AnalystDeps`. Guard all log calls with `this.shipsLog?.log(...)` so the Analyst remains usable without a ships log (e.g., in tests).

### Wiring

In `starbase-runtime-core.ts`, the `ShipsLog` instance is already created. Pass it into:
- `Sentinel` deps (new field)
- `FirstOfficer` deps (new field)
- `Navigator` deps (new field)
- `Analyst` deps (new field)

### Testing

Each role's existing test file gets new assertions:
- Sentinel tests: verify `ShipsLog` calls replace raw SQL for existing events, plus new events are logged
- First Officer tests: verify `ShipsLog` calls replace raw SQL, plus hailing memo and auto-escalation events
- Navigator tests: verify dispatched/completed/failed/timeout events are logged
- Analyst tests: verify each method logs on success and degraded logs on failure

Use a simple `ShipsLog` instance backed by an in-memory SQLite DB (already the pattern in `ships-log.test.ts`).

## Event Type Summary

Total: **27 event types** across 4 roles.

| Role | Migrated | New | Total |
|---|---|---|---|
| Sentinel | 8 | 5 | 13 |
| First Officer | 3 | 2 | 5 |
| Navigator | 0 | 4 | 4 |
| Analyst | 0 | 5 | 5 |
