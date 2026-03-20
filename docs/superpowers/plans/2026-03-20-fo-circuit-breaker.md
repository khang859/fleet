# FO Circuit Breaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix circular retry loops between the First Officer and Admiral by adding error classification, fingerprint tracking, a global mission budget, and migrating memos into the comms system.

**Architecture:** The sentinel gains an error classifier and fingerprint comparator that run before FO dispatch. A global `mission_deployment_count` on missions caps total agent spawns. The `memos` table is dropped — all memos become comms with `type = 'memo'`. FO dispatch becomes async fire-and-forget to unblock the UI.

**Tech Stack:** TypeScript, better-sqlite3, Node.js child_process, Electron IPC

**Spec:** `docs/superpowers/specs/2026-03-20-fo-circuit-breaker-design.md`

---

### Task 1: Database Migration

**Files:**
- Modify: `src/main/starbase/migrations.ts:206` (add migration 10)

- [ ] **Step 1: Write migration 10**

Add after the last migration entry in the `MIGRATIONS` array:

```typescript
{
  version: 10,
  name: '010-fo-circuit-breaker',
  sql: `
    ALTER TABLE missions ADD COLUMN last_error_fingerprint TEXT;
    ALTER TABLE missions ADD COLUMN mission_deployment_count INTEGER DEFAULT 0;
    ALTER TABLE comms ADD COLUMN mission_id INTEGER REFERENCES missions(id);
    CREATE INDEX IF NOT EXISTS idx_comms_mission_type ON comms(mission_id, type, read);
    DROP TABLE IF EXISTS memos;

    INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('max_mission_deployments', '8');
    UPDATE starbase_config SET value = 'claude-haiku-4-5' WHERE key = 'first_officer_model';
  `
}
```

- [ ] **Step 2: Update config defaults**

In `CONFIG_DEFAULTS` at the bottom of `migrations.ts`, change:

```typescript
first_officer_model: 'claude-haiku-4-5',  // was claude-sonnet-4-6
```

And add:

```typescript
max_mission_deployments: 8,
```

- [ ] **Step 3: Run the app to verify migration applies**

Run: `npm run dev`
Expected: App starts without DB errors. Check dev console for `[starbase] Migrated to version 10`.

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/migrations.ts
git commit -m "feat(db): add migration 10 — circuit breaker columns, drop memos"
```

---

### Task 2: Error Fingerprint Utility

**Files:**
- Create: `src/main/starbase/error-fingerprint.ts`
- Create: `src/main/__tests__/error-fingerprint.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { computeFingerprint, classifyError } from '../starbase/error-fingerprint'

describe('computeFingerprint', () => {
  it('returns a 16-char hex string', () => {
    const fp = computeFingerprint('Error: test failed\nat line 42')
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('returns same fingerprint for identical errors', () => {
    const a = computeFingerprint('Error: test failed')
    const b = computeFingerprint('Error: test failed')
    expect(a).toBe(b)
  })

  it('strips timestamps before hashing', () => {
    const a = computeFingerprint('2026-03-20T10:00:00Z Error: test failed')
    const b = computeFingerprint('2026-03-21T15:30:00Z Error: test failed')
    expect(a).toBe(b)
  })

  it('strips PIDs before hashing', () => {
    const a = computeFingerprint('pid=12345 Error: crash')
    const b = computeFingerprint('pid=99999 Error: crash')
    expect(a).toBe(b)
  })

  it('strips memory addresses before hashing', () => {
    const a = computeFingerprint('at 0x7fff5fbff8c0')
    const b = computeFingerprint('at 0x1234abcd0000')
    expect(a).toBe(b)
  })

  it('uses last 50 lines only', () => {
    const longOutput = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const shortOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 50}`).join('\n')
    expect(computeFingerprint(longOutput)).toBe(computeFingerprint(shortOutput))
  })

  it('handles empty input', () => {
    const fp = computeFingerprint('')
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('classifyError', () => {
  it('returns non-retryable for ENOENT', () => {
    expect(classifyError('Error: ENOENT: no such file or directory')).toBe('non-retryable')
  })

  it('returns non-retryable for EACCES', () => {
    expect(classifyError('Error: EACCES: permission denied')).toBe('non-retryable')
  })

  it('returns non-retryable for MODULE_NOT_FOUND', () => {
    expect(classifyError("Error: Cannot find module 'express'")).toBe('non-retryable')
  })

  it('returns non-retryable for 401/403', () => {
    expect(classifyError('HTTP 401 Unauthorized')).toBe('non-retryable')
    expect(classifyError('HTTP 403 Forbidden')).toBe('non-retryable')
  })

  it('returns non-retryable for missing config', () => {
    expect(classifyError('config file not found at /etc/app.json')).toBe('non-retryable')
  })

  it('returns transient for generic errors', () => {
    expect(classifyError('TypeError: Cannot read properties of undefined')).toBe('transient')
  })

  it('returns transient for empty output', () => {
    expect(classifyError('')).toBe('transient')
  })

  it('returns persistent when same fingerprint provided', () => {
    expect(classifyError('some error', 'abc123', 'abc123')).toBe('persistent')
  })

  it('returns transient when different fingerprint provided', () => {
    expect(classifyError('some error', 'abc123', 'def456')).toBe('transient')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/error-fingerprint.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
import { createHash } from 'crypto'

/** Regex patterns that indicate non-retryable errors */
const NON_RETRYABLE_PATTERNS = [
  /ENOENT|EACCES|EPERM/,
  /MODULE_NOT_FOUND|Cannot find module/i,
  /\b401\b.*Unauthorized|\b403\b.*Forbidden/i,
  /config.*not found|missing.*configuration/i,
  /no such file or directory/i,
]

/** Patterns to strip before hashing (variable parts) */
const STRIP_PATTERNS = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ]*/g,         // ISO timestamps
  /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\b/g,           // datetime stamps
  /\bpid[=: ]\d+/gi,                                         // PIDs
  /0x[0-9a-fA-F]{8,}/g,                                      // memory addresses
  /\b\d{4,}\b/g,                                              // large numbers (PIDs, ports)
]

/**
 * Compute a 16-char hex fingerprint from error output.
 * Strips variable parts (timestamps, PIDs, addresses) before hashing.
 * Uses last 50 lines only.
 */
export function computeFingerprint(errorOutput: string): string {
  const lines = errorOutput.split('\n')
  const tail = lines.slice(-50).join('\n')

  let normalized = tail
  for (const pattern of STRIP_PATTERNS) {
    normalized = normalized.replace(pattern, '')
  }

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * Classify an error as transient, persistent, or non-retryable.
 * - non-retryable: matches known unrecoverable patterns (zero retries)
 * - persistent: same fingerprint as last attempt (auto-escalate)
 * - transient: default (allow FO triage)
 */
export function classifyError(
  errorOutput: string,
  currentFingerprint?: string,
  lastFingerprint?: string,
): 'transient' | 'persistent' | 'non-retryable' {
  // Check non-retryable patterns first
  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(errorOutput)) return 'non-retryable'
  }

  // Check fingerprint match (persistent = same error repeating)
  if (currentFingerprint && lastFingerprint && currentFingerprint === lastFingerprint) {
    return 'persistent'
  }

  return 'transient'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/error-fingerprint.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/error-fingerprint.ts src/main/__tests__/error-fingerprint.test.ts
git commit -m "feat(sentinel): add error fingerprint and classifier utility"
```

---

### Task 3: Global Mission Budget in deployCrew

**Files:**
- Modify: `src/main/starbase/crew-service.ts:195` (after `hull.start()`)
- Create: `src/main/__tests__/mission-budget.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StarbaseDB } from '../starbase/db'
import { ConfigService } from '../starbase/config-service'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), 'fleet-test-budget')
const WORKSPACE_DIR = join(TEST_DIR, 'workspace')
const SECTOR_DIR = join(WORKSPACE_DIR, 'api')
const DB_DIR = join(TEST_DIR, 'starbases')

let db: StarbaseDB
let rawDb: ReturnType<StarbaseDB['getDb']>

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(SECTOR_DIR, { recursive: true })
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '')
  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR)
  db.open()
  rawDb = db.getDb()

  // Seed sector and mission
  rawDb.prepare("INSERT INTO sectors (id, name, root_path) VALUES ('api', 'API', ?)").run(SECTOR_DIR)
  rawDb.prepare("INSERT INTO missions (sector_id, summary, prompt) VALUES ('api', 'test', 'test prompt')").run()
})

afterEach(() => {
  db.close()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('mission_deployment_count', () => {
  it('starts at 0 for new missions', () => {
    const row = rawDb.prepare('SELECT mission_deployment_count FROM missions WHERE id = 1').get() as { mission_deployment_count: number }
    expect(row.mission_deployment_count).toBe(0)
  })

  it('can be incremented', () => {
    rawDb.prepare('UPDATE missions SET mission_deployment_count = mission_deployment_count + 1 WHERE id = 1').run()
    const row = rawDb.prepare('SELECT mission_deployment_count FROM missions WHERE id = 1').get() as { mission_deployment_count: number }
    expect(row.mission_deployment_count).toBe(1)
  })

  it('is NOT reset by resetForRequeue fields', () => {
    rawDb.prepare('UPDATE missions SET mission_deployment_count = 5 WHERE id = 1').run()
    // Simulate resetForRequeue
    rawDb.prepare('UPDATE missions SET crew_id = NULL, started_at = NULL, completed_at = NULL, result = NULL WHERE id = 1').run()
    const row = rawDb.prepare('SELECT mission_deployment_count FROM missions WHERE id = 1').get() as { mission_deployment_count: number }
    expect(row.mission_deployment_count).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it passes** (migration should handle this)

Run: `npx vitest run src/main/__tests__/mission-budget.test.ts`
Expected: PASS (column exists from migration 10)

- [ ] **Step 3: Add increment in deployCrew**

In `src/main/starbase/crew-service.ts`, after `await hull.start()` (line 195) and before the eventBus emit, add:

```typescript
    // Increment global mission deployment budget counter
    db.prepare('UPDATE missions SET mission_deployment_count = mission_deployment_count + 1 WHERE id = ?')
      .run(missionId)
```

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/crew-service.ts src/main/__tests__/mission-budget.test.ts
git commit -m "feat(crew): increment mission_deployment_count on successful deploy"
```

---

### Task 4: Sentinel — Error Classifier, Fingerprint, Budget, Query Dedup, Async Dispatch

**Files:**
- Modify: `src/main/starbase/sentinel.ts:276-362` (rewrite `firstOfficerSweep`)

This is the core task. The sentinel's `firstOfficerSweep()` gets 5 changes:

- [ ] **Step 1: Import the fingerprint utility**

At top of `sentinel.ts`, add:

```typescript
import { computeFingerprint, classifyError } from './error-fingerprint'
```

- [ ] **Step 2: Rewrite the firstOfficerSweep query with dedup**

Replace the existing query at lines 282-315 with:

```typescript
  private async firstOfficerSweep(): Promise<void> {
    const { db, configService, firstOfficer } = this.deps
    if (!firstOfficer) return

    const maxRetries = configService.get('first_officer_max_retries') as number
    const maxDeployments = configService.get('max_mission_deployments') as number ?? 8

    const failedCrew = db
      .prepare(
        `SELECT c.id as crew_id, c.sector_id, c.mission_id,
                m.id as mid, m.summary, m.prompt, m.acceptance_criteria,
                m.status as mission_status, m.result, m.verify_result,
                m.review_notes, m.first_officer_retry_count,
                m.last_error_fingerprint, m.mission_deployment_count,
                s.name as sector_name, s.verify_command
         FROM crew c
         JOIN missions m ON m.id = c.mission_id
         JOIN sectors s ON s.id = c.sector_id
         WHERE c.status IN ('error', 'lost', 'timeout')
           AND m.status IN ('failed', 'failed-verification')
           AND m.first_officer_retry_count < ?
           AND m.mission_deployment_count < ?
           AND c.id = (
             SELECT c2.id FROM crew c2
             WHERE c2.mission_id = m.id
               AND c2.status IN ('error', 'lost', 'timeout')
             ORDER BY c2.updated_at DESC
             LIMIT 1
           )
           AND NOT EXISTS (
             SELECT 1 FROM comms
             WHERE type = 'memo' AND mission_id = m.id AND read = 0
           )`
      )
      .all(maxRetries, maxDeployments) as Array<{
        crew_id: string
        sector_id: string
        mission_id: number
        mid: number
        summary: string
        prompt: string
        acceptance_criteria: string | null
        mission_status: string
        result: string | null
        verify_result: string | null
        review_notes: string | null
        first_officer_retry_count: number
        last_error_fingerprint: string | null
        mission_deployment_count: number
        sector_name: string
        verify_command: string | null
      }>
```

- [ ] **Step 3: Add error classification, fingerprint, and async dispatch in the loop**

Replace the existing `for` loop (lines 317-362) with:

```typescript
    for (const row of failedCrew) {
      if (firstOfficer.isRunning(row.crew_id, row.mid)) continue

      // Compute error fingerprint from current failure
      const errorText = (row.result ?? '') + '\n' + (row.verify_result ?? '')
      const fingerprint = computeFingerprint(errorText)

      // Classify the error
      const classification = classifyError(
        errorText,
        fingerprint,
        row.last_error_fingerprint ?? undefined,
      )

      // Update fingerprint on the mission
      db.prepare('UPDATE missions SET last_error_fingerprint = ? WHERE id = ?')
        .run(fingerprint, row.mid)

      // Non-retryable or persistent → auto-escalate without FO
      if (classification !== 'transient') {
        firstOfficer.writeAutoEscalationComm({
          crewId: row.crew_id,
          missionId: row.mid,
          classification,
          fingerprint,
          summary: row.summary,
          errorText: errorText.split('\n').slice(-30).join('\n'),
        })
        continue
      }

      // Get crew output for FO context
      let crewOutput = row.result ?? 'No output captured'
      if (this.deps.crewService) {
        const hullOutput = this.deps.crewService.observeCrew(row.crew_id)
        if (hullOutput) crewOutput = hullOutput
      }
      if (row.verify_result) {
        try {
          const vr = JSON.parse(row.verify_result)
          if (vr.stdout) crewOutput += '\n\n--- Verification Output ---\n' + vr.stdout
          if (vr.stderr) crewOutput += '\n\n--- Verification Stderr ---\n' + vr.stderr
        } catch { /* ignore parse errors */ }
      }

      // Build attempt history from previous memo comms
      const prevMemos = db.prepare(
        `SELECT payload FROM comms
         WHERE type = 'memo' AND mission_id = ? ORDER BY created_at ASC LIMIT 10`
      ).all(row.mid) as Array<{ payload: string }>

      const attemptHistory = prevMemos.map((m, i) => {
        try {
          const p = JSON.parse(m.payload)
          return `| ${i + 1} | ${p.summary?.slice(0, 60) ?? 'unknown'} | ${p.fingerprint ?? '—'} | ${p.classification ?? '—'} |`
        } catch { return null }
      }).filter(Boolean).join('\n')

      // Increment retry count BEFORE dispatch (prevents race on next sweep)
      db.prepare(
        'UPDATE missions SET first_officer_retry_count = first_officer_retry_count + 1 WHERE id = ?'
      ).run(row.mid)

      // Fire-and-forget dispatch (async, non-blocking)
      firstOfficer.dispatch(
        {
          crewId: row.crew_id,
          missionId: row.mid,
          sectorId: row.sector_id,
          sectorName: row.sector_name,
          eventType: row.mission_status === 'failed-verification' ? 'verification-failed' : 'error',
          missionSummary: row.summary,
          missionPrompt: row.prompt,
          acceptanceCriteria: row.acceptance_criteria,
          verifyCommand: row.verify_command,
          crewOutput,
          verifyResult: row.verify_result,
          reviewNotes: row.review_notes,
          retryCount: row.first_officer_retry_count,
          attemptHistory: attemptHistory || undefined,
        },
        {
          onExit: (code) => {
            db.prepare(
              "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'first_officer_dispatched', ?)"
            ).run(row.crew_id, JSON.stringify({
              missionId: row.mid,
              retryCount: row.first_officer_retry_count + 1,
              exitCode: code,
            }))
            this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
          },
        },
      ).catch(err => {
        console.error(`[sentinel] FO dispatch error for mission ${row.mid}:`, err)
      })
    }
```

- [ ] **Step 4: Update the hailing dedup query**

In the same function, update the unanswered hailing query (around line 365-401). Replace the `NOT EXISTS` subquery that references `memos` with:

```sql
AND cr.mission_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM comms
  WHERE type = 'hailing-memo' AND mission_id = cr.mission_id AND read = 0
)
```

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/sentinel.ts
git commit -m "feat(sentinel): error classifier, fingerprint, budget, dedup, async dispatch"
```

---

### Task 5: FirstOfficer — Comms Integration, Async Callbacks, Prompt Changes

**Files:**
- Modify: `src/main/starbase/first-officer.ts`

- [ ] **Step 1: Update ActionableEvent type**

Add `attemptHistory?: string` to the `ActionableEvent` type at line 22-36.

- [ ] **Step 2: Update constructor deps — remove MemoService, add DB**

Replace the `FirstOfficerDeps` type: remove `memoService: MemoService`, keep `db: Database.Database`. The DB is already in deps. Remove the `MemoService` import.

- [ ] **Step 3: Add `onExit` callback to dispatch**

Change `dispatch` signature:

```typescript
async dispatch(
  event: ActionableEvent,
  callbacks?: { onExit?: (code: number | null) => void },
): Promise<boolean> {
```

In the `proc.on('exit', ...)` handler (line 204), call the callback:

```typescript
proc.on('exit', (code) => {
  clearTimeout(timer)
  this.running.delete(k)
  // ... existing cleanup ...
  callbacks?.onExit?.(code)
  this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
})
```

- [ ] **Step 4: Replace all memoService.insert() calls with comms INSERTs**

In `writeEscalationMemo()` (line 269-308), replace:

```typescript
this.deps.memoService.insert({
  crewId: event.crewId,
  missionId: event.missionId,
  eventType: event.eventType,
  filePath,
  retryCount: event.retryCount,
})
```

With:

```typescript
this.deps.db.prepare(
  `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
   VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
).run(
  event.missionId,
  JSON.stringify({
    missionId: event.missionId,
    crewId: event.crewId,
    eventType: event.eventType,
    summary: reason,
    filePath,
    retryCount: event.retryCount,
    fingerprint: null,
    classification: 'escalation',
  })
)
this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
```

- [ ] **Step 5: Replace memoService.insert() in scanForNewMemos()**

In `scanForNewMemos()` (line 242-266), replace the `memoService.insert` call with the same comms INSERT pattern. Also check against comms instead of memos:

```typescript
const existing = this.deps.db
  .prepare("SELECT 1 FROM comms WHERE type = 'memo' AND payload LIKE ? LIMIT 1")
  .get(`%"filePath":"${filePath.replace(/"/g, '\\"')}"%`)
if (existing) continue
```

Match on `filePath` inside the payload JSON to maintain exact dedup (mirrors the old file_path exact match):

```typescript
const payloadMatch = JSON.stringify({ filePath })
const existing = this.deps.db
  .prepare(
    `SELECT 1 FROM comms WHERE type = 'memo' AND mission_id = ? AND payload LIKE ? LIMIT 1`
  )
  .get(event.missionId, `%${filePath.replace(/"/g, '\\"')}%`)
if (existing) continue
```

- [ ] **Step 6: Migrate writeHailingMemo() to comms**

Replace `memoService.insert` in `writeHailingMemo()` with:

```typescript
this.deps.db.prepare(
  `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
   VALUES ('first-officer', 'admiral', 'hailing-memo', ?, ?)`
).run(
  opts.missionId,
  JSON.stringify({
    crewId: opts.crewId,
    missionId: opts.missionId,
    summary: `Unanswered hailing from ${opts.crewId} in ${opts.sectorName}`,
    filePath,
  })
)
this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
```

- [ ] **Step 7: Add writeAutoEscalationComm() method**

This is called by the sentinel for persistent/non-retryable errors (no FO process spawned):

```typescript
writeAutoEscalationComm(opts: {
  crewId: string
  missionId: number
  classification: string
  fingerprint: string
  summary: string
  errorText: string
}): void {
  const memosDir = join(this.getWorkspacePath(), 'memos')
  mkdirSync(memosDir, { recursive: true })

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  const slug = opts.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
  const filename = `${ts}-auto-${slug}.md`
  const filePath = join(memosDir, filename)

  const content = `## Auto-Escalated: ${opts.summary}

**Classification:** ${opts.classification}
**Fingerprint:** ${opts.fingerprint}
**Crew:** ${opts.crewId}

### Error Output (tail)
\`\`\`
${opts.errorText}
\`\`\`

### Why Auto-Escalated
${opts.classification === 'persistent' ? 'Same error fingerprint as previous attempt — retrying will not help.' : 'Error matches non-retryable pattern — requires manual intervention.'}
`
  writeFileSync(filePath, content, 'utf-8')

  this.deps.db.prepare(
    `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
     VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
  ).run(
    opts.missionId,
    JSON.stringify({
      missionId: opts.missionId,
      crewId: opts.crewId,
      eventType: 'auto-escalation',
      summary: `Auto-escalated (${opts.classification}): ${opts.summary}`,
      filePath,
      fingerprint: opts.fingerprint,
      classification: opts.classification,
    })
  )
  this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
}
```

- [ ] **Step 8: Update getStatus() to use comms query**

Replace `getStatus()`:

```typescript
getStatus(): 'idle' | 'working' | 'memo' {
  if (this.running.size > 0) return 'working'
  const row = this.deps.db.prepare(
    "SELECT COUNT(*) as cnt FROM comms WHERE type IN ('memo', 'hailing-memo') AND to_crew = 'admiral' AND read = 0"
  ).get() as { cnt: number }
  if (row.cnt > 0) return 'memo'
  return 'idle'
}
```

- [ ] **Step 9: Add attempt history to buildInitialMessage()**

In `buildInitialMessage()` (line 467), before the final `msg += ...` line, add:

```typescript
if (event.attemptHistory) {
  msg += `\n## Previous Attempts\n| # | Action | Fingerprint | Classification |\n|---|--------|-------------|----------------|\n${event.attemptHistory}\n`
}
```

- [ ] **Step 10: Update CLAUDE.md template with mandatory retry memo rule**

In `generateClaudeMd()` (line 361), add to the `## Rules` section:

```
- When choosing RETRY, you MUST ALSO write a short memo to ./memos/ documenting what you tried and why you expect the retry to succeed. This is mandatory for audit trail.
```

- [ ] **Step 11: Commit**

```bash
git add src/main/starbase/first-officer.ts
git commit -m "feat(fo): comms integration, async callbacks, attempt history, auto-escalation"
```

---

### Task 6: Hull — Migrate Review Escalation to Comms

**Files:**
- Modify: `src/main/starbase/hull.ts:612-625`

- [ ] **Step 1: Replace memos INSERT with comms INSERT**

At line 622-624 in `hull.ts`, replace:

```typescript
db.prepare(
  "INSERT INTO memos (id, crew_id, mission_id, event_type, file_path, status) VALUES (?, ?, ?, 'review-escalation', ?, 'unread')"
).run(memoId, crewId, missionId, memoPath)
```

With:

```typescript
db.prepare(
  `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
   VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
).run(
  missionId,
  JSON.stringify({
    missionId,
    crewId,
    eventType: 'review-escalation',
    summary: `Review escalation: ${verdict} on mission #${missionId}`,
    filePath: memoPath,
    classification: 'review-escalation',
  })
)
```

Note: there is only ONE `INSERT INTO memos` in `hull.ts` (at line 622-624). The second review block around line 855 does NOT write to memos — it only writes to `comms review_verdict` and `ships_log`. No change needed there.

- [ ] **Step 2: Commit**

```bash
git add src/main/starbase/hull.ts
git commit -m "feat(hull): migrate review escalation writes to comms"
```

---

### Task 7: Delete MemoService, Update index.ts Wiring

**Files:**
- Delete: `src/main/starbase/memo-service.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Remove MemoService import and instantiation from index.ts**

In `src/main/index.ts`:
- Remove line 33: `import { MemoService } from './starbase/memo-service'`
- Remove line 53: `let memoServiceRef: MemoService | null = null`
- Remove lines 229-230: `memoServiceRef = new MemoService(...)` and `const memoService = memoServiceRef`
- Remove `memoService` from the `FirstOfficer` constructor call (line 235)
- Replace `memoService.getUnreadCount()` calls (lines 367, 375) with a direct DB query:

```typescript
function getUnreadMemoCount(): number {
  return (starbaseDb!.getDb().prepare(
    "SELECT COUNT(*) as cnt FROM comms WHERE type IN ('memo', 'hailing-memo') AND to_crew = 'admiral' AND read = 0"
  ).get() as { cnt: number }).cnt
}
```

Use `getUnreadMemoCount()` wherever `memoService.getUnreadCount()` was called.

- Remove `memoServiceRef` from the `registerIpcHandlers` call (line 497).

- [ ] **Step 2: Delete memo-service.ts**

```bash
rm src/main/starbase/memo-service.ts
```

- [ ] **Step 3: Commit**

```bash
git add -A src/main/starbase/memo-service.ts src/main/index.ts
git commit -m "refactor: remove MemoService, wire FO directly to comms"
```

---

### Task 8: IPC Handlers and Preload — Memo to Comms

**Files:**
- Modify: `src/main/ipc-handlers.ts:332-358`
- Modify: `src/preload/index.ts:174-181`
- Modify: `src/shared/constants.ts:71-74`

- [ ] **Step 1: Update IPC handlers**

In `ipc-handlers.ts`, replace the `if (memoService) { ... }` block (lines 332-358) with:

```typescript
// First Officer: Memo handlers (backed by comms table)
const memoDb = starbaseDb?.getDb()
if (memoDb) {
  ipcMain.handle(IPC_CHANNELS.MEMO_LIST, () => {
    return memoDb.prepare(
      "SELECT id, from_crew as crew_id, mission_id, type as event_type, payload, read, created_at FROM comms WHERE type IN ('memo', 'hailing-memo') ORDER BY created_at DESC"
    ).all().map((row: any) => {
      try {
        const p = JSON.parse(row.payload ?? '{}')
        return { ...row, file_path: p.filePath ?? '', status: row.read ? 'read' : 'unread', summary: p.summary ?? '' }
      } catch { return { ...row, file_path: '', status: row.read ? 'read' : 'unread', summary: '' } }
    })
  })

  ipcMain.handle(IPC_CHANNELS.MEMO_READ, (_e, id: number) => {
    memoDb.prepare("UPDATE comms SET read = 1 WHERE id = ?").run(id)
    eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  })

  ipcMain.handle(IPC_CHANNELS.MEMO_DISMISS, (_e, id: number) => {
    memoDb.prepare("DELETE FROM comms WHERE id = ?").run(id)
    eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  })

  ipcMain.handle(IPC_CHANNELS.MEMO_CONTENT, async (_e, filePath: string) => {
    const allowedBase = join(process.env.HOME ?? '~', '.fleet', 'starbases')
    const resolved = resolve(filePath)
    if (!resolved.startsWith(allowedBase) || !resolved.includes('first-officer/memos/')) {
      return null
    }
    try {
      return await readFile(resolved, 'utf-8')
    } catch {
      return null
    }
  })
}
```

Note: The `registerIpcHandlers` function signature needs to drop the `memoService` parameter. Update the function signature and the call site in `index.ts`.

- [ ] **Step 1b: Update preload API types**

In `src/preload/index.ts`, update the memo API types from `string` to `number` for IDs:

```typescript
memoList: (): Promise<unknown[]> =>
  ipcRenderer.invoke(IPC_CHANNELS.MEMO_LIST),
memoRead: (id: number): Promise<void> =>           // was string
  ipcRenderer.invoke(IPC_CHANNELS.MEMO_READ, id),
memoDismiss: (id: number): Promise<void> =>         // was string
  ipcRenderer.invoke(IPC_CHANNELS.MEMO_DISMISS, id),
memoContent: (filePath: string): Promise<string | null> =>
  ipcRenderer.invoke(IPC_CHANNELS.MEMO_CONTENT, filePath),
```

- [ ] **Step 2: Update MemoInfo type in star-command-store.ts**

In `src/renderer/src/store/star-command-store.ts`, update `MemoInfo` to match the new shape:

```typescript
export type MemoInfo = {
  id: number  // was string — comms uses INTEGER PK
  crew_id: string | null
  mission_id: number | null
  event_type: string
  file_path: string
  status: string
  summary: string
  created_at: string
}
```

- [ ] **Step 3: Update MemoPanel to use numeric IDs and summary**

In `MemoPanel.tsx`, update `selectMemo` and `dismissMemo` to pass `memo.id` as number. Add the summary display in the list:

```typescript
<span className="text-xs text-neutral-300 truncate">
  {memo.summary || memo.event_type}
</span>
```

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/preload/index.ts src/shared/constants.ts src/renderer/src/store/star-command-store.ts src/renderer/src/components/star-command/MemoPanel.tsx
git commit -m "feat(ipc): migrate memo handlers to comms-backed queries"
```

---

### Task 9: Workspace Templates — Admiral Memo Docs

**Files:**
- Modify: `src/main/starbase/workspace-templates.ts`

- [ ] **Step 1: Add memo comms documentation to Admiral CLAUDE.md template**

Find the comms type table in the Admiral template and add a row for `memo`:

```
| \`memo\` | Escalation report from the First Officer | Read the summary in payload. For full details, read the markdown file at \`payload.filePath\`. Decide whether to create a new mission, adjust scope, or investigate manually. |
| \`hailing-memo\` | Crew waiting for a response >60s | Review and respond via \`fleet crew message\` |
```

- [ ] **Step 2: Commit**

```bash
git add src/main/starbase/workspace-templates.ts
git commit -m "docs(admiral): add memo and hailing-memo comms type documentation"
```

---

### Task 10: Update Tests

**Files:**
- Modify: `src/main/__tests__/first-officer.test.ts`

- [ ] **Step 1: Remove MemoService from test setup**

Replace `MemoService` import and instantiation with direct DB queries. Update `firstOfficer` constructor to not pass `memoService`.

- [ ] **Step 2: Update test assertions to check comms table**

Replace all `memoService.listAll()` / `memoService.listUnread()` calls with:

```typescript
const memos = rawDb.prepare(
  "SELECT * FROM comms WHERE type IN ('memo', 'hailing-memo') ORDER BY created_at DESC"
).all() as Array<{ id: number; payload: string; read: number }>
```

Update assertions to check `payload` JSON for `crewId`, `missionId`, etc.

- [ ] **Step 3: Update getStatus test**

The `getStatus() returns memo` test should insert a comms row instead of calling `writeHailingMemo` (or still call it — the method now writes to comms).

- [ ] **Step 4: Add new tests for circuit breaker behavior**

```typescript
it('dispatch() writes auto-escalation comm for persistent errors', () => {
  // Set a fingerprint on the mission (simulating previous failure)
  rawDb.prepare('UPDATE missions SET last_error_fingerprint = ? WHERE id = ?')
    .run('abc123', missionId)

  // This should be testable via writeAutoEscalationComm
  firstOfficer.writeAutoEscalationComm({
    crewId: CREW_ID,
    missionId,
    classification: 'persistent',
    fingerprint: 'abc123',
    summary: 'Test failure',
    errorText: 'Error: test failed',
  })

  const comms = rawDb.prepare(
    "SELECT * FROM comms WHERE type = 'memo' AND mission_id = ?"
  ).all(missionId) as Array<{ payload: string }>

  expect(comms.length).toBe(1)
  const payload = JSON.parse(comms[0].payload)
  expect(payload.classification).toBe('persistent')
})
```

- [ ] **Step 5: Rewrite the existing `dispatch() writes an escalation memo` test**

The test at line 102-129 directly uses `memoService.listAll()`. Rewrite it to query comms:

```typescript
it('dispatch() writes an escalation comm when retryCount >= maxRetries', async () => {
  const maxRetries = configService.get('first_officer_max_retries') as number
  const event = makeEvent({ retryCount: maxRetries })
  const result = await firstOfficer.dispatch(event)

  expect(result).toBe(true)

  const comms = rawDb.prepare(
    "SELECT * FROM comms WHERE type = 'memo' AND mission_id = ?"
  ).all(missionId) as Array<{ payload: string }>

  expect(comms.length).toBeGreaterThanOrEqual(1)
  const payload = JSON.parse(comms[0].payload)
  expect(payload.crewId).toBe(CREW_ID)
  expect(payload.missionId).toBe(missionId)
  expect(payload.summary).toContain('Maximum retries exhausted')
})
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run src/main/__tests__/first-officer.test.ts src/main/__tests__/error-fingerprint.test.ts src/main/__tests__/mission-budget.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/__tests__/first-officer.test.ts
git commit -m "test: update FO tests for comms-backed memos and circuit breaker"
```

---

### Task 11: Sentinel Integration Tests

**Files:**
- Create: `src/main/__tests__/sentinel-circuit-breaker.test.ts`

- [ ] **Step 1: Write sentinel integration tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StarbaseDB } from '../starbase/db'
import { ConfigService } from '../starbase/config-service'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), 'fleet-test-sentinel-cb')
const WORKSPACE_DIR = join(TEST_DIR, 'workspace')
const SECTOR_DIR = join(WORKSPACE_DIR, 'api')
const DB_DIR = join(TEST_DIR, 'starbases')

let db: StarbaseDB
let rawDb: ReturnType<StarbaseDB['getDb']>
let configService: ConfigService

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(SECTOR_DIR, { recursive: true })
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '')
  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR)
  db.open()
  rawDb = db.getDb()
  configService = new ConfigService(rawDb)

  // Seed sector and mission
  rawDb.prepare("INSERT INTO sectors (id, name, root_path) VALUES ('api', 'API', ?)").run(SECTOR_DIR)
  rawDb.prepare(
    "INSERT INTO missions (sector_id, summary, prompt, status) VALUES ('api', 'test mission', 'test prompt', 'failed')"
  ).run()
  rawDb.prepare(
    "INSERT INTO crew (id, sector_id, mission_id, status) VALUES ('crew-1', 'api', 1, 'error')"
  ).run()
})

afterEach(() => {
  db.close()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('sentinel circuit breaker query guards', () => {
  it('query dedup picks only latest crew per mission', () => {
    // Add a second older errored crew for the same mission
    rawDb.prepare(
      "INSERT INTO crew (id, sector_id, mission_id, status, updated_at) VALUES ('crew-0', 'api', 1, 'error', datetime('now', '-1 hour'))"
    ).run()

    const rows = rawDb.prepare(
      `SELECT c.id as crew_id FROM crew c
       JOIN missions m ON m.id = c.mission_id
       WHERE c.status IN ('error', 'lost', 'timeout')
         AND m.status IN ('failed', 'failed-verification')
         AND c.id = (
           SELECT c2.id FROM crew c2
           WHERE c2.mission_id = m.id AND c2.status IN ('error', 'lost', 'timeout')
           ORDER BY c2.updated_at DESC LIMIT 1
         )`
    ).all() as Array<{ crew_id: string }>

    expect(rows.length).toBe(1)
    expect(rows[0].crew_id).toBe('crew-1') // most recent
  })

  it('budget gate excludes missions at deployment limit', () => {
    const maxDeploy = configService.get('max_mission_deployments') as number ?? 8
    rawDb.prepare('UPDATE missions SET mission_deployment_count = ? WHERE id = 1').run(maxDeploy)

    const rows = rawDb.prepare(
      `SELECT c.id FROM crew c
       JOIN missions m ON m.id = c.mission_id
       WHERE c.status = 'error' AND m.status = 'failed'
         AND m.mission_deployment_count < ?`
    ).all(maxDeploy) as Array<{ id: string }>

    expect(rows.length).toBe(0)
  })

  it('comms dedup blocks dispatch when unread memo exists', () => {
    rawDb.prepare(
      "INSERT INTO comms (from_crew, to_crew, type, mission_id, payload, read) VALUES ('first-officer', 'admiral', 'memo', 1, '{}', 0)"
    ).run()

    const rows = rawDb.prepare(
      `SELECT c.id FROM crew c
       JOIN missions m ON m.id = c.mission_id
       WHERE c.status = 'error' AND m.status = 'failed'
         AND NOT EXISTS (
           SELECT 1 FROM comms WHERE type = 'memo' AND mission_id = m.id AND read = 0
         )`
    ).all() as Array<{ id: string }>

    expect(rows.length).toBe(0)
  })

  it('comms dedup allows dispatch when memo is read', () => {
    rawDb.prepare(
      "INSERT INTO comms (from_crew, to_crew, type, mission_id, payload, read) VALUES ('first-officer', 'admiral', 'memo', 1, '{}', 1)"
    ).run()

    const rows = rawDb.prepare(
      `SELECT c.id FROM crew c
       JOIN missions m ON m.id = c.mission_id
       WHERE c.status = 'error' AND m.status = 'failed'
         AND NOT EXISTS (
           SELECT 1 FROM comms WHERE type = 'memo' AND mission_id = m.id AND read = 0
         )`
    ).all() as Array<{ id: string }>

    expect(rows.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/main/__tests__/sentinel-circuit-breaker.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/__tests__/sentinel-circuit-breaker.test.ts
git commit -m "test: add sentinel circuit breaker query guard tests"
```

---

### Task 12: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. No references to `memos` table remain in test code.

- [ ] **Step 2: Search for stale memos references**

Run: `grep -r "memoService\|memo_service\|MemoService\|FROM memos\|INTO memos" src/ --include="*.ts" | grep -v node_modules | grep -v __tests__`
Expected: No results (all references migrated to comms)

- [ ] **Step 3: Run app and test manually**

Run: `npm run dev`
Verify:
- Star Command tab opens without errors
- MemoPanel shows (or is empty if no memos)
- FO status shows in sidebar
- No console errors about `memos` table

- [ ] **Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: address any remaining stale memo references"
```
