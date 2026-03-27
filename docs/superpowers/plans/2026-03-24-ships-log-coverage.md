# Ships Log Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all role activity logging through the `ShipsLog` class, replacing raw SQL and adding missing events for Navigator and Analyst.

**Architecture:** Inject `ShipsLog` as a dependency into all four role classes (Sentinel, FirstOfficer, Navigator, Analyst). Replace 11 raw SQL inserts with `shipsLog.log()` calls. Add 16 new log events. All `shipsLog.log()` calls are fire-and-forget (wrapped in try/catch).

**Tech Stack:** TypeScript, better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-03-24-ships-log-coverage-design.md`

---

## File Map

| File                                       | Action | Responsibility                                                     |
| ------------------------------------------ | ------ | ------------------------------------------------------------------ |
| `src/main/starbase/analyst.ts`             | Modify | Add `shipsLog` to deps, log 5 events                               |
| `src/main/starbase/navigator.ts`           | Modify | Add `shipsLog` to deps, log 4 events, add `timedOut` Set           |
| `src/main/starbase/first-officer.ts`       | Modify | Add `shipsLog` to deps, migrate 3 raw SQL → ShipsLog, add 2 events |
| `src/main/starbase/sentinel.ts`            | Modify | Add `shipsLog` to deps, migrate 8 raw SQL → ShipsLog, add 5 events |
| `src/main/starbase-runtime-core.ts`        | Modify | Move `shipsLog` creation earlier, wire into all 4 roles            |
| `src/main/__tests__/analyst.test.ts`       | Modify | Add assertions for 5 new log events                                |
| `src/main/__tests__/navigator.test.ts`     | Modify | Add assertions for 4 new log events                                |
| `src/main/__tests__/first-officer.test.ts` | Modify | Add ShipsLog to setup, verify migration + 2 new events             |
| `src/main/__tests__/sentinel.test.ts`      | Modify | Add ShipsLog to setup, verify migration + 5 new events             |

**Task ordering note:** Tasks 1-2 (Analyst, Navigator) add `shipsLog` as optional deps, so they don't break the global typecheck. Tasks 3-4 (First Officer, Sentinel) add it as required, which will cause `npm run typecheck` to fail until Task 5 wires it in the runtime. Run individual test files (not global typecheck) between Tasks 3-4 and 5. Alternatively, execute Task 5 immediately after Task 2 if you prefer a green typecheck at every step.

---

### Task 1: Analyst — add ShipsLog dependency and 5 log events

**Files:**

- Modify: `src/main/starbase/analyst.ts`
- Modify: `src/main/__tests__/analyst.test.ts`

- [ ] **Step 1: Add `shipsLog` to AnalystDeps and constructor**

In `src/main/starbase/analyst.ts`, add the import and field:

```typescript
// At top of file, add import:
import type { ShipsLog } from './ships-log';

// In AnalystDeps interface, add:
export interface AnalystDeps {
  db: Database.Database;
  filterEnv?: () => Record<string, string>;
  model?: string;
  timeoutMs?: number;
  shipsLog?: ShipsLog;  // <-- add this
}

// In the class, add field and assign in constructor:
private readonly shipsLog?: ShipsLog;

constructor(deps: AnalystDeps) {
  this.db = deps.db;
  this.getEnv = deps.filterEnv ?? defaultFilterEnv;
  this.model = deps.model ?? DEFAULT_MODEL;
  this.timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  this.shipsLog = deps.shipsLog;  // <-- add this
}
```

- [ ] **Step 2: Add log calls to each public method**

In `classifyError()`, after the successful `if (c === 'transient' || ...)` block (before `return c`):

```typescript
if (c === 'transient' || c === 'persistent' || c === 'non-retryable') {
  try {
    this.shipsLog?.log({
      eventType: 'analyst_classified',
      detail: { classification: c, method: 'classifyError' }
    });
  } catch {
    /* fire-and-forget */
  }
  return c;
}
```

In `summarizeCILogs()`, after the successful `if` block (before `return String(summary)`):

```typescript
try {
  this.shipsLog?.log({ eventType: 'analyst_summarized', detail: { method: 'summarizeCILogs' } });
} catch {
  /* fire-and-forget */
}
return String(summary);
```

In `extractPRVerdict()`, after the successful `if (v === 'APPROVE' || ...)` block (before the `return`):

```typescript
try {
  this.shipsLog?.log({
    eventType: 'analyst_verdict_extracted',
    detail: { verdict: v, method: 'extractPRVerdict' }
  });
} catch {
  /* fire-and-forget */
}
return { verdict: v, notes: typeof notes === 'string' ? notes : '' };
```

In `writeHailingContext()`, after the successful `if` block (before `return String(context)`):

```typescript
try {
  this.shipsLog?.log({
    eventType: 'analyst_hailing_context',
    detail: { method: 'writeHailingContext' }
  });
} catch {
  /* fire-and-forget */
}
return String(context);
```

In `writeDegradedComm()`, **after** the existing `try { this.db.prepare(...) } catch { }` block (outside it, not inside), add an independent try/catch so the ships log fires even if the comms DB insert fails:

```typescript
// existing code:
try {
  this.db.prepare(`INSERT INTO comms ...`).run(...);
} catch {
  // Best-effort
}
// ADD after the existing try/catch:
try { this.shipsLog?.log({ eventType: 'analyst_degraded', detail: { method, reason: reason.slice(0, 500) } }); } catch { /* fire-and-forget */ }
```

- [ ] **Step 3: Update tests — create ShipsLog-backed test helper**

In `src/main/__tests__/analyst.test.ts`, the existing tests use a fake `makeDb()` that stubs `prepare().run()`. For ships log assertions, add a `ShipsLog` spy:

```typescript
import { ShipsLog } from '../starbase/ships-log';

// Add after the makeDb function:
function makeShipsLog() {
  const logSpy = vi.fn().mockReturnValue(1);
  return { log: logSpy } as unknown as ShipsLog & { log: ReturnType<typeof vi.fn> };
}
```

- [ ] **Step 4: Add test for `analyst_classified` event**

Add in the `classifyError` describe block:

```typescript
it('logs analyst_classified to ships log on success', async () => {
  mockProc = makeMockProc('{"classification": "transient", "reason": "blip"}');
  const shipsLog = makeShipsLog();
  const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
  await analyst.classifyError('Error: connection reset');
  expect(shipsLog.log).toHaveBeenCalledWith({
    eventType: 'analyst_classified',
    detail: { classification: 'transient', method: 'classifyError' }
  });
});
```

- [ ] **Step 5: Add test for `analyst_summarized` event**

```typescript
it('logs analyst_summarized to ships log on success', async () => {
  mockProc = makeMockProc('{"summary": "Build failed"}');
  const shipsLog = makeShipsLog();
  const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
  await analyst.summarizeCILogs('raw logs');
  expect(shipsLog.log).toHaveBeenCalledWith({
    eventType: 'analyst_summarized',
    detail: { method: 'summarizeCILogs' }
  });
});
```

- [ ] **Step 6: Add test for `analyst_verdict_extracted` event**

```typescript
it('logs analyst_verdict_extracted to ships log on success', async () => {
  mockProc = makeMockProc('{"verdict": "APPROVE", "notes": "LGTM"}');
  const shipsLog = makeShipsLog();
  const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
  await analyst.extractPRVerdict('output');
  expect(shipsLog.log).toHaveBeenCalledWith({
    eventType: 'analyst_verdict_extracted',
    detail: { verdict: 'APPROVE', method: 'extractPRVerdict' }
  });
});
```

- [ ] **Step 7: Add test for `analyst_hailing_context` event**

```typescript
it('logs analyst_hailing_context to ships log on success', async () => {
  mockProc = makeMockProc('{"context": "The crew is stuck."}');
  const shipsLog = makeShipsLog();
  const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
  await analyst.writeHailingContext('question');
  expect(shipsLog.log).toHaveBeenCalledWith({
    eventType: 'analyst_hailing_context',
    detail: { method: 'writeHailingContext' }
  });
});
```

- [ ] **Step 8: Add test for `analyst_degraded` event**

```typescript
it('logs analyst_degraded to ships log on failure', async () => {
  mockProc = makeMockProc('', 1);
  const shipsLog = makeShipsLog();
  const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
  await analyst.classifyError('some error');
  expect(shipsLog.log).toHaveBeenCalledWith({
    eventType: 'analyst_degraded',
    detail: expect.objectContaining({ method: 'classifyError' })
  });
});
```

- [ ] **Step 9: Run tests**

Run: `npx vitest run src/main/__tests__/analyst.test.ts`
Expected: All tests pass including new ships log assertions.

- [ ] **Step 10: Commit**

```bash
git add src/main/starbase/analyst.ts src/main/__tests__/analyst.test.ts
git commit -m "feat(analyst): log activities to ships log"
```

---

### Task 2: Navigator — add ShipsLog dependency, timedOut tracking, and 4 log events

**Files:**

- Modify: `src/main/starbase/navigator.ts`
- Modify: `src/main/__tests__/navigator.test.ts`

- [ ] **Step 1: Add `shipsLog` and `timedOut` to Navigator**

In `src/main/starbase/navigator.ts`:

```typescript
// Add import at top:
import type { ShipsLog } from './ships-log';

// Add to NavigatorDeps type:
shipsLog?: ShipsLog;

// In the class, add fields:
private timedOut = new Set<string>();

// Access shipsLog via this.deps.shipsLog
```

- [ ] **Step 2: Add `navigator_dispatched` log after successful spawn**

In `dispatch()`, right after `this.running.set(event.executionId, ...)` and before writing initMsg (around line 119-124):

```typescript
try {
  this.deps.shipsLog?.log({
    eventType: 'navigator_dispatched',
    detail: {
      executionId: event.executionId,
      protocolSlug: event.protocolSlug,
      step: event.currentStep
    }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 3: Add timeout tracking and `navigator_timeout` log**

In the `setTimeout` callback (around line 165-182), after `proc.kill('SIGTERM')`:

```typescript
const timer = setTimeout(() => {
  if (!proc.killed) {
    console.warn(`[navigator] Timeout for ${event.executionId}, killing`);
    this.timedOut.add(event.executionId); // <-- add this
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    setTimeout(() => {
      if (!proc.killed)
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
    }, 5000);
  }
}, timeout * 1000);
```

- [ ] **Step 4: Add `navigator_completed`, `navigator_failed`, and `navigator_timeout` logs in exit handler**

In the `proc.on('exit', ...)` callback, after `this.running.delete(event.executionId)` and temp file cleanup:

```typescript
proc.on('exit', (code) => {
  clearTimeout(timer);
  this.running.delete(event.executionId);
  try {
    unlinkSync(spFile);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(msgFile);
  } catch {
    /* ignore */
  }

  // Log the outcome
  const wasTimeout = this.timedOut.delete(event.executionId);
  if (wasTimeout) {
    // Still write failed comm so protocol_executions status is updated to 'failed'
    this.writeFailedComm(event, `Navigator process timed out`);
    try {
      this.deps.shipsLog?.log({
        eventType: 'navigator_timeout',
        detail: { executionId: event.executionId, protocolSlug: event.protocolSlug }
      });
    } catch {
      /* fire-and-forget */
    }
  } else if (code !== 0) {
    this.writeFailedComm(event, `Navigator process crashed (exit code: ${code})`);
    try {
      this.deps.shipsLog?.log({
        eventType: 'navigator_failed',
        detail: {
          executionId: event.executionId,
          protocolSlug: event.protocolSlug,
          reason: `exit code ${code}`
        }
      });
    } catch {
      /* fire-and-forget */
    }
  } else {
    try {
      this.deps.shipsLog?.log({
        eventType: 'navigator_completed',
        detail: { executionId: event.executionId, protocolSlug: event.protocolSlug }
      });
    } catch {
      /* fire-and-forget */
    }
  }

  callbacks?.onExit?.(code);
  this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
});
```

Note: The existing `if (code !== 0) { this.writeFailedComm(...) }` block moves into the `else if` branch. The timeout case still calls `writeFailedComm` to ensure `protocol_executions` status is updated to 'failed'. The `wasTimeout` guard distinguishes the ships log event type (`navigator_timeout` vs `navigator_failed`).

- [ ] **Step 5: Add `navigator_failed` log in error handler**

In `proc.on('error', ...)`:

```typescript
proc.on('error', (err) => {
  clearTimeout(timer);
  this.running.delete(event.executionId);
  this.writeFailedComm(event, `Navigator spawn failed: ${err.message}`);
  try {
    this.deps.shipsLog?.log({
      eventType: 'navigator_failed',
      detail: {
        executionId: event.executionId,
        protocolSlug: event.protocolSlug,
        reason: err.message
      }
    });
  } catch {
    /* fire-and-forget */
  }
  this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
});
```

Also in the outer catch block at the end of `dispatch()`:

```typescript
} catch (err) {
  this.writeFailedComm(event, `Navigator spawn failed: ${err instanceof Error ? err.message : 'unknown'}`);
  try {
    this.deps.shipsLog?.log({
      eventType: 'navigator_failed',
      detail: { executionId: event.executionId, protocolSlug: event.protocolSlug, reason: err instanceof Error ? err.message : 'unknown' }
    });
  } catch { /* fire-and-forget */ }
  return false;
}
```

- [ ] **Step 6: Also clear timedOut set in `reconcile()` and `shutdown()`**

```typescript
reconcile(): void {
  this.running.clear();
  this.timedOut.clear();  // <-- add
}

shutdown(): void {
  for (const [k, entry] of this.running) {
    try { entry.proc.kill('SIGKILL'); } catch { /* already dead */ }
    this.running.delete(k);
  }
  this.timedOut.clear();  // <-- add
}
```

- [ ] **Step 7: Add navigator ships log tests**

In `src/main/__tests__/navigator.test.ts`, add import and helper:

```typescript
import { ShipsLog } from '../starbase/ships-log';

function makeShipsLog() {
  const logSpy = vi.fn().mockReturnValue(1);
  return { log: logSpy } as unknown as ShipsLog & { log: ReturnType<typeof vi.fn> };
}
```

Add test cases. Since Navigator spawns `claude` (unavailable in tests), test the dedup/status paths and verify shipsLog is wired:

```typescript
it('accepts shipsLog in deps without error', () => {
  const shipsLog = makeShipsLog();
  const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123', shipsLog });
  expect(nav.activeCount).toBe(0);
});

it('clears timedOut set on reconcile', () => {
  const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
  const timedOut = (nav as unknown as { timedOut: Set<string> }).timedOut;
  timedOut.add('exec-1');
  nav.reconcile();
  expect(timedOut.size).toBe(0);
});

it('clears timedOut set on shutdown', () => {
  const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
  const timedOut = (nav as unknown as { timedOut: Set<string> }).timedOut;
  timedOut.add('exec-1');
  nav.shutdown();
  expect(timedOut.size).toBe(0);
});
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run src/main/__tests__/navigator.test.ts`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/main/starbase/navigator.ts src/main/__tests__/navigator.test.ts
git commit -m "feat(navigator): log activities to ships log"
```

---

### Task 3: First Officer — add ShipsLog dependency, migrate 3 events, add 2 new events

**Files:**

- Modify: `src/main/starbase/first-officer.ts`
- Modify: `src/main/__tests__/first-officer.test.ts`

- [ ] **Step 1: Add `shipsLog` to FirstOfficerDeps and constructor**

In `src/main/starbase/first-officer.ts`:

```typescript
// Add import at top:
import type { ShipsLog } from './ships-log';

// Add to FirstOfficerDeps type:
shipsLog: ShipsLog;
```

No constructor changes needed — deps are accessed via `this.deps.shipsLog`.

- [ ] **Step 2: Migrate `first_officer_retried` in `resolveRetry()`**

Replace the raw SQL at lines 611-623:

```typescript
// BEFORE:
this.deps.db
  .prepare(
    "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'first_officer_retried', ?)"
  )
  .run(
    event.crewId,
    JSON.stringify({
      missionId: event.missionId,
      reason: decision.reason,
      revisedPrompt,
      deployResult
    })
  );

// AFTER:
try {
  this.deps.shipsLog.log({
    crewId: event.crewId,
    eventType: 'first_officer_retried',
    detail: { missionId: event.missionId, reason: decision.reason, revisedPrompt, deployResult }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 3: Migrate `first_officer_recovered` in `resolveRecovery()`**

Replace the raw SQL at lines 678-691:

```typescript
// AFTER:
try {
  this.deps.shipsLog.log({
    crewId: event.crewId,
    eventType: 'first_officer_recovered',
    detail: {
      missionId: event.missionId,
      reason: decision.reason,
      cargoCreated,
      fingerprint: event.fingerprint ?? null,
      classification: event.classification ?? null
    }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 4: Migrate `first_officer_dismissed` in `resolveEscalation()`**

Replace the raw SQL at lines 756-769:

```typescript
// AFTER:
try {
  this.deps.shipsLog.log({
    crewId: event.crewId,
    eventType: 'first_officer_dismissed',
    detail: {
      missionId: event.missionId,
      reason: summaryReason,
      cargoCreated,
      fingerprint: event.fingerprint ?? null,
      classification: event.classification ?? null
    }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 5: Add `hailing_memo_written` log in `writeHailingMemo()`**

After the existing `this.deps.db.prepare(...INSERT INTO comms...)` block at the end of `writeHailingMemo()`, before `this.deps.eventBus?.emit(...)`:

```typescript
try {
  this.deps.shipsLog.log({
    crewId: opts.crewId,
    eventType: 'hailing_memo_written',
    detail: { missionId: opts.missionId, sectorName: opts.sectorName }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 6: Add `auto_escalation` log in `writeAutoEscalationComm()`**

After the existing `this.deps.db.prepare(...INSERT INTO comms...)` block at the end of `writeAutoEscalationComm()`, before `this.deps.eventBus?.emit(...)`:

```typescript
try {
  this.deps.shipsLog.log({
    crewId: opts.crewId,
    eventType: 'auto_escalation',
    detail: {
      missionId: opts.missionId,
      classification: opts.classification,
      fingerprint: opts.fingerprint
    }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 7: Update test setup to include ShipsLog**

In `src/main/__tests__/first-officer.test.ts`, add import and wire in `beforeEach`:

```typescript
import { ShipsLog } from '../starbase/ships-log';
```

In the `beforeEach`, add `shipsLog` to the `firstOfficer` construction. Also add `deleteCrew` and `observeCrew` stubs to the crewService mock — these are called by `resolveRecovery()` and `resolveEscalation()` but were missing from the existing mock:

```typescript
const shipsLog = new ShipsLog(rawDb);

firstOfficer = new FirstOfficer({
  db: rawDb,
  configService,
  missionService,
  cargoService,
  crewService: {
    recallCrew: () => {},
    deployCrew: () => ({ crewId: 'replacement', missionId }),
    deleteCrew: () => {}, // <-- new stub needed for escalation paths
    observeCrew: () => null // <-- new stub needed for FO context building
  } as any,
  starbaseId: db.getStarbaseId(),
  shipsLog // <-- add this
});
```

- [ ] **Step 8: Add test verifying ships log events are written**

Add a test that checks the ships_log table after a decision is applied. Since `dispatch()` spawns `claude`, test through direct method invocation on the decision paths. The existing test for `getStatus()` shows the pattern — we can verify ships_log entries via the DB:

```typescript
it('logs first_officer_dismissed to ships_log on escalation', async () => {
  const shipsLog = new ShipsLog(rawDb);
  const fo = new FirstOfficer({
    db: rawDb,
    configService,
    missionService,
    cargoService,
    crewService: {
      recallCrew: () => {},
      deployCrew: () => ({ crewId: 'replacement', missionId }),
      deleteCrew: () => {},
      observeCrew: () => null
    } as any,
    starbaseId: db.getStarbaseId(),
    shipsLog
  });

  // Trigger max-retries escalation path (no claude spawn needed)
  const event = makeEvent({ retryCount: 99 });
  await fo.dispatch(event);

  const entries = shipsLog.query({ eventType: 'first_officer_dismissed' });
  expect(entries).toHaveLength(1);
  expect(entries[0].crew_id).toBe(CREW_ID);
  const detail = JSON.parse(entries[0].detail!);
  expect(detail.missionId).toBe(missionId);
});
```

- [ ] **Step 9: Verify no raw ships_log SQL remains in first-officer.ts**

Run: `grep "INSERT INTO ships_log" src/main/starbase/first-officer.ts`
Expected: No output (zero matches).

- [ ] **Step 10: Run tests**

Run: `npx vitest run src/main/__tests__/first-officer.test.ts`
Expected: All tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/main/starbase/first-officer.ts src/main/__tests__/first-officer.test.ts
git commit -m "feat(first-officer): migrate to ShipsLog class, add hailing and auto-escalation events"
```

---

### Task 4: Sentinel — add ShipsLog dependency, migrate 8 events, add 5 new events

**Files:**

- Modify: `src/main/starbase/sentinel.ts`
- Modify: `src/main/__tests__/sentinel.test.ts`

- [ ] **Step 1: Add `shipsLog` to SentinelDeps and store as field**

In `src/main/starbase/sentinel.ts`:

```typescript
// Add import at top:
import type { ShipsLog } from './ships-log';

// Add to SentinelDeps type:
shipsLog: ShipsLog;

// Add field in class and assign in constructor:
private shipsLog: ShipsLog;

constructor(private deps: SentinelDeps) {
  this.db = deps.db;
  this.eventBus = deps.eventBus;
  this.configService = deps.configService;
  this.navigator = deps.navigator;
  this.protocolService = new ProtocolService(deps.db);
  this.shipsLog = deps.shipsLog;  // <-- add this
}
```

- [ ] **Step 2: Migrate `lifesign_lost` in `_runSweep()`**

Replace the raw SQL (around line 229-231):

```typescript
// BEFORE:
db.prepare(
  "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'lifesign_lost', ?)"
).run(crew.id, JSON.stringify({ sectorId: crew.sector_id }));

// AFTER:
try {
  this.shipsLog.log({
    crewId: crew.id,
    eventType: 'lifesign_lost',
    detail: { sectorId: crew.sector_id }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 3: Migrate `timeout` in `_runSweep()`**

Replace the raw SQL (around line 259-261):

```typescript
// BEFORE:
db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'timeout', ?)").run(
  crew.id,
  JSON.stringify({ reason: 'deadline expired' })
);

// AFTER:
try {
  this.shipsLog.log({
    crewId: crew.id,
    eventType: 'timeout',
    detail: { reason: 'deadline expired' }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 4: Migrate `sector_path_missing` in `_runSweep()`**

Replace the raw SQL (around line 283-285):

```typescript
// BEFORE:
db.prepare("INSERT INTO ships_log (event_type, detail) VALUES ('sector_path_missing', ?)").run(
  JSON.stringify({ sectorId: sector.id, path: sector.root_path })
);

// AFTER:
try {
  this.shipsLog.log({
    eventType: 'sector_path_missing',
    detail: { sectorId: sector.id, path: sector.root_path }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 5: Add `disk_warning` new event in `_runSweep()` step 5**

Inside the `if (diskLevel && this.lastAlertLevel['disk_warning'] !== diskLevel)` block, after the comms insert:

```typescript
if (diskLevel && this.lastAlertLevel['disk_warning'] !== diskLevel) {
  this.lastAlertLevel['disk_warning'] = diskLevel;
  db.prepare("INSERT INTO comms ...").run(...);  // existing comms insert
  try {
    this.shipsLog.log({
      eventType: 'disk_warning',
      detail: { usedGb: usedGb.toFixed(2), budgetGb: diskBudgetGb, percent: pct.toFixed(0) }
    });
  } catch { /* fire-and-forget */ }
}
```

- [ ] **Step 6: Add `memory_warning` new event in `_runSweep()` step 6**

Inside the `if (memLevel && this.lastAlertLevel['memory_warning'] !== memLevel)` block, after the comms insert:

```typescript
if (memLevel && this.lastAlertLevel['memory_warning'] !== memLevel) {
  this.lastAlertLevel['memory_warning'] = memLevel;
  db.prepare("INSERT INTO comms ...").run(...);  // existing comms insert
  try {
    this.shipsLog.log({
      eventType: 'memory_warning',
      detail: { freeMemoryGb: availableGb.toFixed(2), level: memLevel }
    });
  } catch { /* fire-and-forget */ }
}
```

- [ ] **Step 7: Migrate `socket_restart` in `checkSocketHealth()`**

Replace the raw SQL (around line 410-412):

```typescript
// BEFORE:
this.deps.db
  .prepare("INSERT INTO ships_log (event_type, detail) VALUES ('socket_restart', ?)")
  .run(JSON.stringify({ reason: '3 consecutive ping failures' }));

// AFTER:
try {
  this.shipsLog.log({
    eventType: 'socket_restart',
    detail: { reason: '3 consecutive ping failures' }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 8: Migrate `first_officer_dispatched` in `firstOfficerSweep()`**

Replace the raw SQL inside the `onExit` callback (around line 548-557):

```typescript
// BEFORE:
db.prepare(
  "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'first_officer_dispatched', ?)"
).run(
  row.crew_id,
  JSON.stringify({
    missionId: row.mid,
    retryCount: row.first_officer_retry_count + 1,
    exitCode: code
  })
);

// AFTER:
try {
  this.shipsLog.log({
    crewId: row.crew_id,
    eventType: 'first_officer_dispatched',
    detail: { missionId: row.mid, retryCount: row.first_officer_retry_count + 1, exitCode: code }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 9: Add `gate_expired` new event in `navigatorSweep()`**

After the `this.protocolService.updateExecutionStatus(exec.id, 'gate-expired')` call, before or after the comms insert:

```typescript
try {
  this.shipsLog.log({
    eventType: 'gate_expired',
    detail: { executionId: exec.id, protocolId: exec.protocol_id }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 10: Add `navigator_fan_out_failed` in `navigatorSweep()` crew-failed block**

After the `await this.navigator.dispatch(...)` call in the crew-failed loop:

```typescript
await this.navigator.dispatch({
  executionId: row.executionId,
  protocolSlug: proto.slug,
  featureRequest: row.feature_request,
  currentStep: row.current_step,
  context: row.context,
  eventType: 'crew-failed'
});
try {
  this.shipsLog.log({
    eventType: 'navigator_fan_out_failed',
    detail: { executionId: row.executionId, protocolSlug: proto.slug, step: row.current_step }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 11: Add `navigator_fan_out_completed` in `navigatorSweep()` crew-completed block**

After the `crew-completed` comms insert and navigator dispatch, before `this.eventBus?.emit(...)`:

```typescript
try {
  this.shipsLog.log({
    eventType: 'navigator_fan_out_completed',
    detail: { executionId: row.executionId, missionId: row.missionId }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 12: Migrate `review_crew_dispatched` in `reviewSweep()`**

Replace the raw SQL (around line 827-829):

```typescript
// BEFORE:
db.prepare("INSERT INTO ships_log (event_type, detail) VALUES ('review_crew_dispatched', ?)").run(
  JSON.stringify({ missionId: mission.id, prBranch: mission.pr_branch })
);

// AFTER:
try {
  this.shipsLog.log({
    eventType: 'review_crew_dispatched',
    detail: { missionId: mission.id, prBranch: mission.pr_branch }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 13: Migrate `review_escalated` in `reviewSweep()`**

Replace the raw SQL (around line 870-872):

```typescript
// BEFORE:
db.prepare("INSERT INTO ships_log (event_type, detail) VALUES ('review_escalated', ?)").run(
  JSON.stringify({ missionId: mission.id, reviewRound: mission.review_round })
);

// AFTER:
try {
  this.shipsLog.log({
    eventType: 'review_escalated',
    detail: { missionId: mission.id, reviewRound: mission.review_round }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 14: Migrate `fix_crew_dispatched` in `reviewSweep()`**

Replace the raw SQL (around line 911-918):

```typescript
// BEFORE:
db.prepare("INSERT INTO ships_log (event_type, detail) VALUES ('fix_crew_dispatched', ?)").run(
  JSON.stringify({
    missionId: mission.id,
    prBranch: mission.pr_branch,
    round: mission.review_round
  })
);

// AFTER:
try {
  this.shipsLog.log({
    eventType: 'fix_crew_dispatched',
    detail: { missionId: mission.id, prBranch: mission.pr_branch, round: mission.review_round }
  });
} catch {
  /* fire-and-forget */
}
```

- [ ] **Step 15: Verify no raw ships_log SQL remains in sentinel.ts**

Run: `grep "INSERT INTO ships_log" src/main/starbase/sentinel.ts`
Expected: No output (zero matches).

- [ ] **Step 16: Update test setup to include ShipsLog**

In `src/main/__tests__/sentinel.test.ts`, add import and wire in `beforeEach`:

```typescript
import { ShipsLog } from '../starbase/ships-log';
```

Every `new Sentinel({...})` call in the test file needs `shipsLog: new ShipsLog(getDb())` added to its deps. Search for all `new Sentinel(` in the test file and add the field.

- [ ] **Step 17: Add test for lifesign_lost ships log event**

Find the existing test that verifies lifesign_lost behavior (crew marked as 'lost'). Add an assertion after the sweep:

```typescript
const logEntries = new ShipsLog(getDb()).query({ eventType: 'lifesign_lost' });
expect(logEntries.length).toBeGreaterThanOrEqual(1);
expect(logEntries[0].crew_id).toBe('crew-stale');
```

- [ ] **Step 18: Add test for timeout ships log event**

Find or create a test for deadline timeout. After the sweep, assert:

```typescript
const logEntries = new ShipsLog(getDb()).query({ eventType: 'timeout' });
expect(logEntries.length).toBeGreaterThanOrEqual(1);
```

- [ ] **Step 19: Run tests**

Run: `npx vitest run src/main/__tests__/sentinel.test.ts`
Expected: All tests pass.

- [ ] **Step 20: Commit**

```bash
git add src/main/starbase/sentinel.ts src/main/__tests__/sentinel.test.ts
git commit -m "feat(sentinel): migrate to ShipsLog class, add disk/memory/gate/fan-out events"
```

---

### Task 5: Wire ShipsLog into all roles in starbase-runtime-core.ts

**Files:**

- Modify: `src/main/starbase-runtime-core.ts`

- [ ] **Step 1: Move `shipsLog` creation before `analyst`**

In `src/main/starbase-runtime-core.ts`, the current order is:

```
analyst (line 632) → crewService → firstOfficer → navigator → shipsLog (line 678) → sentinel
```

Move the `const shipsLog = new ShipsLog(...)` line to just before `const analyst = ...`:

```typescript
const shipsLog = new ShipsLog(localStarbaseDb.getDb());
trace('bootstrap shipsLog ready');

const analyst = new Analyst({
  db: localStarbaseDb.getDb(),
  model: configService.getOptionalString('analyst_model'),
  shipsLog // <-- add
});
trace('bootstrap analyst ready');
```

Remove the old `const shipsLog = new ShipsLog(...)` line and its trace at the former location (around line 678-679).

- [ ] **Step 2: Add `shipsLog` to FirstOfficer deps**

```typescript
const firstOfficer = new FirstOfficer({
  db: localStarbaseDb.getDb(),
  configService,
  missionService,
  crewService,
  cargoService,
  eventBus: this.eventBus,
  starbaseId: localStarbaseDb.getStarbaseId(),
  crewEnv: args.env,
  fleetBinDir: args.fleetBinPath,
  analyst,
  shipsLog // <-- add
});
```

- [ ] **Step 3: Add `shipsLog` to Navigator deps**

```typescript
const navigator = new Navigator({
  db: localStarbaseDb.getDb(),
  configService,
  eventBus: this.eventBus,
  starbaseId: localStarbaseDb.getStarbaseId(),
  crewEnv: args.env,
  fleetBinDir: args.fleetBinPath,
  shipsLog // <-- add
});
```

- [ ] **Step 4: Add `shipsLog` to Sentinel deps**

```typescript
const sentinel = new Sentinel({
  db: localStarbaseDb.getDb(),
  configService,
  eventBus: this.eventBus,
  firstOfficer,
  navigator,
  crewService,
  missionService,
  analyst,
  shipsLog // <-- add
});
```

- [ ] **Step 5: Update the trace message**

The old trace `'bootstrap navigator/shipsLog ready'` should be split since shipsLog is now created earlier. Change the trace near the navigator to just `'bootstrap navigator ready'`.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/starbase-runtime-core.ts
git commit -m "feat: wire ShipsLog into all role dependencies"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run src/main/__tests__/analyst.test.ts src/main/__tests__/navigator.test.ts src/main/__tests__/first-officer.test.ts src/main/__tests__/sentinel.test.ts src/main/__tests__/ships-log.test.ts`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 4: Verify zero raw SQL inserts remain**

Run: `grep -r "INSERT INTO ships_log" src/main/starbase/sentinel.ts src/main/starbase/first-officer.ts src/main/starbase/navigator.ts src/main/starbase/analyst.ts`
Expected: No output (zero matches). The only file that should contain this SQL is `src/main/starbase/ships-log.ts` itself.

- [ ] **Step 5: Commit any remaining fixes**

If any linting or type fixes were needed, commit them.
