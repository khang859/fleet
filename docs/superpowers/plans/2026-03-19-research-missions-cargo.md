# Research Missions & Cargo Documentation Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow crews deployed for research/documentation/review tasks to complete successfully without git changes, producing cargo artifacts instead of commits.

**Architecture:** Add a `type` column to missions (migration), thread it through mission-service → crew-service → hull, and branch the hull cleanup logic so research missions with no git changes produce cargo files + DB records instead of being marked as errors.

**Tech Stack:** TypeScript, better-sqlite3, vitest, node fs

**Spec:** `docs/superpowers/specs/2026-03-19-research-missions-cargo-design.md`

---

### Task 1: Database Migration — Add `type` Column to Missions

**Files:**
- Modify: `src/main/starbase/migrations.ts:145-155` (add migration version 6)

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/mission-service.test.ts`:

```typescript
it('should store and return mission type', () => {
  const m = missionSvc.addMission({
    sectorId: 'api',
    summary: 'Research auth patterns',
    prompt: 'Investigate auth patterns in the codebase',
    type: 'research',
  });
  expect(m.type).toBe('research');
});

it('should default mission type to code', () => {
  const m = missionSvc.addMission({
    sectorId: 'api',
    summary: 'Add endpoint',
    prompt: 'Create a /users endpoint',
  });
  expect(m.type).toBe('code');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/mission-service.test.ts`
Expected: FAIL — `type` property doesn't exist on AddMissionOpts or MissionRow

- [ ] **Step 3: Add migration**

In `src/main/starbase/migrations.ts`, add after the version 5 migration:

```typescript
{
  version: 6,
  name: '006-mission-type',
  sql: `
    ALTER TABLE missions ADD COLUMN type TEXT DEFAULT 'code';
  `
}
```

- [ ] **Step 4: Update MissionRow type**

In `src/main/starbase/mission-service.ts`, add `type: string` to `MissionRow` (after `status`):

```typescript
type MissionRow = {
  id: number
  sector_id: string
  crew_id: string | null
  summary: string
  prompt: string
  acceptance_criteria: string | null
  status: string
  type: string
  priority: number
  // ... rest unchanged
}
```

- [ ] **Step 5: Update AddMissionOpts**

In `src/main/starbase/mission-service.ts`, add `type?: string` to `AddMissionOpts`:

```typescript
type AddMissionOpts = {
  sectorId: string
  summary: string
  prompt: string
  acceptanceCriteria?: string
  priority?: number
  dependsOnMissionId?: number
  type?: string
}
```

- [ ] **Step 6: Update addMission INSERT**

In `src/main/starbase/mission-service.ts`, update the `addMission` method to include `type`:

```typescript
addMission(opts: AddMissionOpts): MissionRow {
  const result = this.db
    .prepare(
      `INSERT INTO missions (sector_id, summary, prompt, acceptance_criteria, priority, depends_on_mission_id, type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.sectorId,
      opts.summary,
      opts.prompt,
      opts.acceptanceCriteria ?? null,
      opts.priority ?? 0,
      opts.dependsOnMissionId ?? null,
      opts.type ?? 'code'
    )

  const mission = this.getMission(result.lastInsertRowid as number)!
  this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  return mission
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/mission-service.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/starbase/migrations.ts src/main/starbase/mission-service.ts src/main/__tests__/mission-service.test.ts
git commit -m "feat(starbase): add mission type column with migration and service support"
```

---

### Task 2: Thread Mission Type Through Call Sites

**Files:**
- Modify: `src/main/socket-server.ts:195-204` (mission.create handler)
- Modify: `src/main/socket-server.ts:230-259` (crew.deploy handler)
- Modify: `src/main/starbase/crew-service.ts:71-72` (deployCrew opts)
- Modify: `src/main/starbase/crew-service.ts:84-91` (inline mission creation)

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/socket-server.test.ts` (in the appropriate describe block — find the existing `mission.create` tests):

```typescript
it('mission.create forwards type parameter', async () => {
  const sock = tmpSocket();
  const services = makeMockServices();
  const server = new SocketServer(sock, services);
  await server.start();

  const resp = await sendCommand(sock, {
    command: 'mission.create',
    args: { sector: 'alpha', summary: 'Research', prompt: 'Investigate', type: 'research' },
  });

  expect(services.missionService.addMission).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'research' }),
  );

  await server.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts -t "mission.create forwards type"`
Expected: FAIL — `type` not passed to `addMission`

- [ ] **Step 3: Update socket-server mission.create**

In `src/main/socket-server.ts`, update the `mission.create` case:

```typescript
case 'mission.create': {
  const mission = missionService.addMission({
    sectorId: (args.sector ?? args.sectorId) as string,
    summary: args.summary as string,
    prompt: args.prompt as string,
    dependsOnMissionId: args['depends-on'] ? Number(args['depends-on']) : undefined,
    type: args.type as string | undefined,
  });
  this.emit('state-change', 'mission:changed', { mission });
  return mission;
}
```

- [ ] **Step 4: Update crew.deploy to forward type**

In `src/main/socket-server.ts`, update the `crew.deploy` case to pass type:

```typescript
const result = await crewService.deployCrew({
  sectorId: (args.sector ?? args.sectorId) as string,
  prompt,
  missionId,
  type: args.type as string | undefined,
});
```

- [ ] **Step 5: Update deployCrew opts signature**

In `src/main/starbase/crew-service.ts`, update the `deployCrew` parameter type:

```typescript
async deployCrew(
  opts: { sectorId: string; prompt: string; missionId?: number; type?: string },
): Promise<DeployResult> {
```

- [ ] **Step 6: Forward type in inline mission creation**

In `src/main/starbase/crew-service.ts`, update the `addMission` call inside `deployCrew`:

```typescript
if (!missionId) {
  const mission = missionService.addMission({
    sectorId: opts.sectorId,
    summary: opts.prompt.slice(0, 100),
    prompt: opts.prompt,
    type: opts.type,
  });
  missionId = mission.id;
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/socket-server.ts src/main/starbase/crew-service.ts src/main/__tests__/socket-server.test.ts
git commit -m "feat(starbase): thread mission type through socket-server and crew-service"
```

---

### Task 3: Wire Mission Type and StarbaseId into Hull

**Files:**
- Modify: `src/main/starbase/hull.ts:32-59` (HullOpts type)
- Modify: `src/main/starbase/hull.ts:333-367` (handleStreamMessage — capture resultText)
- Modify: `src/main/starbase/hull.ts:321-327` (appendOutput — raise cap for research)
- Modify: `src/main/starbase/crew-service.ts:138-164` (Hull construction)

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/hull.test.ts`:

```typescript
it('should accept missionType and starbaseId in opts', () => {
  const mission = missionSvc.addMission({
    sectorId: 'api',
    summary: 'Test',
    prompt: 'echo hello',
    type: 'research',
  })
  const hull = new Hull({
    crewId: 'hull-crew',
    sectorId: 'api',
    missionId: mission.id,
    prompt: 'echo hello',
    worktreePath: WORKTREE_DIR,
    worktreeBranch: 'crew/hull-crew',
    baseBranch: 'main',
    sectorPath: SECTOR_DIR,
    db: db.getDb(),
    missionType: 'research',
    starbaseId: 'abc123',
  })
  expect(hull).toBeDefined()
  expect(hull.getStatus()).toBe('pending')
})

it('should use higher output cap for research missions', () => {
  const mission = missionSvc.addMission({
    sectorId: 'api',
    summary: 'Test',
    prompt: 'echo hello',
    type: 'research',
  })
  const hull = new Hull({
    crewId: 'hull-crew',
    sectorId: 'api',
    missionId: mission.id,
    prompt: 'echo hello',
    worktreePath: WORKTREE_DIR,
    worktreeBranch: 'crew/hull-crew',
    baseBranch: 'main',
    sectorPath: SECTOR_DIR,
    db: db.getDb(),
    missionType: 'research',
    starbaseId: 'abc123',
  })
  // Append 500 lines — should all be kept for research (cap is 2000)
  for (let i = 0; i < 500; i++) {
    hull.appendOutput(`line ${i}`)
  }
  const output = hull.getOutputBuffer()
  expect(output).toContain('line 0')
  expect(output).toContain('line 499')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/hull.test.ts -t "should accept missionType"`
Expected: FAIL — `missionType` not in HullOpts

- [ ] **Step 3: Add missionType and starbaseId to HullOpts**

In `src/main/starbase/hull.ts`, add to the `HullOpts` type:

```typescript
export type HullOpts = {
  // ... existing fields ...
  /** Mission type: 'code' (default) or 'research' */
  missionType?: string
  /** Starbase ID for cargo file storage paths */
  starbaseId?: string
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Add resultText field and capture it**

In `src/main/starbase/hull.ts`, add a private field:

```typescript
private resultText: string | null = null
```

In `handleStreamMessage()`, **modify the existing** `else if (msg.type === 'result')` block (do NOT add a duplicate branch). Add the resultText capture at the top of the existing block:

```typescript
} else if (msg.type === 'result') {
  // Capture result text for research mission cargo
  const rm = msg as ClaudeResultMessage
  if (rm.result) {
    this.resultText = rm.result
  }
  // Close stdin so the process exits naturally — (existing code below unchanged)
  try { this.process?.stdin?.end() } catch { /* ignore */ }
  // ... rest of existing escalation fallback unchanged ...
```

- [ ] **Step 5: Raise output cap for research missions**

In `src/main/starbase/hull.ts`, update `appendOutput()`:

```typescript
appendOutput(data: string): void {
  const lines = data.split('\n')
  this.outputLines.push(...lines)
  const maxLines = this.opts.missionType === 'research' ? 2000 : MAX_OUTPUT_LINES
  if (this.outputLines.length > maxLines) {
    this.outputLines = this.outputLines.slice(-maxLines)
  }
}
```

- [ ] **Step 6: Wire in crew-service**

In `src/main/starbase/crew-service.ts`, after the missionId is resolved (around line 91), read the mission type:

```typescript
// Read mission type for Hull
const missionRow = missionService.getMission(missionId)!
const missionType = missionRow.type ?? 'code'
```

Then in the Hull construction (around line 142), add the new fields:

```typescript
const hull = new Hull({
  // ... existing fields ...
  missionType,
  starbaseId,
  // ... rest unchanged ...
});
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/main/__tests__/hull.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/starbase/hull.ts src/main/starbase/crew-service.ts src/main/__tests__/hull.test.ts
git commit -m "feat(starbase): wire missionType and starbaseId into Hull, capture resultText, raise output cap"
```

---

### Task 4: Research Mission Cleanup — Cargo Production

**Files:**
- Modify: `src/main/starbase/hull.ts:409-493` (cleanup method — research branch)

- [ ] **Step 1: Write the failing test**

Add a new describe block to `src/main/__tests__/hull.test.ts`:

```typescript
describe('Hull — Research mission cleanup', () => {
  function createMockProcess() {
    const proc = new EventEmitter() as any
    proc.stdin = { write: vi.fn(), end: vi.fn(), writable: true }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.killed = false
    proc.pid = 12345
    proc.kill = vi.fn()
    return proc
  }

  beforeEach(() => {
    mockProc = createMockProcess()
  })

  const BARE_REMOTE_DIR = join(TEST_DIR, 'remote.git')

  // Setup worktree with NO changes (research scenario)
  function setupWorktreeNoChanges() {
    mkdirSync(BARE_REMOTE_DIR, { recursive: true })
    execSync('git init --bare', { cwd: BARE_REMOTE_DIR })
    execSync(`git remote add origin "${BARE_REMOTE_DIR}"`, { cwd: SECTOR_DIR })
    execSync('git push -u origin main', { cwd: SECTOR_DIR })
    execSync('git branch crew/test-branch main', { cwd: SECTOR_DIR })
    mkdirSync(join(TEST_DIR, 'worktrees', 'test-sb'), { recursive: true })
    execSync(`git worktree add "${WORKTREE_DIR}" crew/test-branch`, { cwd: SECTOR_DIR })
    // No new files — worktree matches base branch exactly
  }

  it('research mission with no changes — marks completed, produces cargo', { timeout: 60_000 }, async () => {
    setupWorktreeNoChanges()
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Research auth',
      prompt: 'Investigate auth patterns',
      type: 'research',
    })
    const opts: HullOpts = {
      crewId: `crew-${mission.id}`,
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'Investigate auth patterns',
      worktreePath: WORKTREE_DIR,
      worktreeBranch: 'crew/test-branch',
      baseBranch: 'main',
      sectorPath: SECTOR_DIR,
      db: db.getDb(),
      lifesignIntervalSec: 9999,
      timeoutMin: 9999,
      missionType: 'research',
      starbaseId: 'test01',
    }
    const hull = new Hull(opts)

    // Add some output to simulate research work
    await hull.start()
    // Simulate assistant output via stdout
    const outputMsg = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Found 3 auth patterns in the codebase.' }] },
      session_id: 'test'
    })
    mockProc.stdout.emit('data', Buffer.from(outputMsg + '\n'))
    mockProc.emit('exit', 0)

    await new Promise((r) => setTimeout(r, 500))

    // Mission should be completed, not failed
    const row = db.getDb()
      .prepare('SELECT status, result FROM missions WHERE id = ?')
      .get(mission.id) as any
    expect(row.status).toBe('completed')
    expect(row.result).toContain('Research completed')

    // Crew should be complete, not error
    const crew = db.getDb()
      .prepare('SELECT status FROM crew WHERE id = ?')
      .get(opts.crewId) as any
    expect(crew.status).toBe('complete')

    // Cargo should exist
    const cargo = db.getDb()
      .prepare('SELECT * FROM cargo WHERE mission_id = ?')
      .all(mission.id) as any[]
    expect(cargo.length).toBe(2)
    expect(cargo.map((c: any) => c.type).sort()).toEqual(['documentation_full', 'documentation_summary'])
    expect(cargo.every((c: any) => c.verified === 1)).toBe(true)

    // Comms should be sent
    const comms = db.getDb()
      .prepare("SELECT payload FROM comms WHERE from_crew = ? AND type = 'mission_complete'")
      .get(opts.crewId) as any
    expect(comms).toBeTruthy()
    const payload = JSON.parse(comms.payload)
    expect(payload.status).toBe('completed')
    expect(payload.cargoProduced).toBe(true)
  })

  it('research mission that crashes — still marks as error', { timeout: 60_000 }, async () => {
    setupWorktreeNoChanges()
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Research auth',
      prompt: 'Investigate auth patterns',
      type: 'research',
    })
    const opts: HullOpts = {
      crewId: `crew-crash-${mission.id}`,
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'Investigate auth patterns',
      worktreePath: WORKTREE_DIR,
      worktreeBranch: 'crew/test-branch',
      baseBranch: 'main',
      sectorPath: SECTOR_DIR,
      db: db.getDb(),
      lifesignIntervalSec: 9999,
      timeoutMin: 9999,
      missionType: 'research',
      starbaseId: 'test01',
    }
    const hull = new Hull(opts)

    await hull.start()
    // Simulate crash — non-zero exit
    mockProc.emit('exit', 1)

    await new Promise((r) => setTimeout(r, 500))

    // Mission should be failed, NOT completed
    const row = db.getDb()
      .prepare('SELECT status, result FROM missions WHERE id = ?')
      .get(mission.id) as any
    expect(row.status).toBe('failed')
    expect(row.result).toBe('No work produced')

    // Crew should be error
    const crew = db.getDb()
      .prepare('SELECT status FROM crew WHERE id = ?')
      .get(opts.crewId) as any
    expect(crew.status).toBe('error')

    // No cargo should be produced
    const cargo = db.getDb()
      .prepare('SELECT * FROM cargo WHERE mission_id = ?')
      .all(mission.id) as any[]
    expect(cargo.length).toBe(0)
  })

  it('code mission with no changes — still marks as failed (existing behavior)', { timeout: 60_000 }, async () => {
    setupWorktreeNoChanges()
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Add endpoint',
      prompt: 'Create a /users endpoint',
    })
    const opts: HullOpts = {
      crewId: `crew-${mission.id}`,
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'Create a /users endpoint',
      worktreePath: WORKTREE_DIR,
      worktreeBranch: 'crew/test-branch',
      baseBranch: 'main',
      sectorPath: SECTOR_DIR,
      db: db.getDb(),
      lifesignIntervalSec: 9999,
      timeoutMin: 9999,
      missionType: 'code',
      starbaseId: 'test01',
    }
    const hull = new Hull(opts)

    await hull.start()
    mockProc.emit('exit', 0)

    await new Promise((r) => setTimeout(r, 500))

    // Mission should be failed (existing behavior)
    const row = db.getDb()
      .prepare('SELECT status, result FROM missions WHERE id = ?')
      .get(mission.id) as any
    expect(row.status).toBe('failed')
    expect(row.result).toBe('No work produced')

    // Crew should be error
    const crew = db.getDb()
      .prepare('SELECT status FROM crew WHERE id = ?')
      .get(opts.crewId) as any
    expect(crew.status).toBe('error')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/hull.test.ts -t "Research mission"`
Expected: FAIL — research mission gets `failed`/`error` like code missions

- [ ] **Step 3: Implement research branch in cleanup**

In `src/main/starbase/hull.ts`, in the `cleanup` method, replace the `if (!hasChanges)` block (lines 470-493) with:

```typescript
if (!hasChanges) {
  if (status !== 'aborted') {
    if (this.opts.missionType === 'research' && status !== 'error') {
      // Research mission completed — produce cargo instead of failing
      overrideStatus = 'complete'

      // Write cargo files to starbase directory
      const cargoDir = join(
        process.env.HOME ?? '~',
        '.fleet', 'starbases',
        `starbase-${this.opts.starbaseId}`,
        'cargo', this.opts.sectorId, String(missionId)
      )
      const fullOutput = this.outputLines.join('\n')
      const summary = this.resultText ?? this.outputLines.slice(-20).join('\n')
      const hasOutput = fullOutput.trim().length > 0
      const resultMsg = hasOutput ? 'Research completed' : 'Research completed (no output captured)'

      // Attempt to write cargo files
      let fullOutputPath: string | null = null
      let summaryPath: string | null = null
      let fullManifest: string
      let summaryManifest: string

      try {
        mkdirSync(cargoDir, { recursive: true })
        fullOutputPath = join(cargoDir, 'full-output.md')
        summaryPath = join(cargoDir, 'summary.md')
        writeFileSync(fullOutputPath, fullOutput, 'utf-8')
        writeFileSync(summaryPath, summary, 'utf-8')
        fullManifest = JSON.stringify({ path: fullOutputPath })
        summaryManifest = JSON.stringify({ path: summaryPath })
      } catch (fileErr) {
        console.error(`[hull:${crewId}] cargo file write failed:`, fileErr)
        // Fallback: store content directly in manifest
        fullManifest = JSON.stringify({ content: fullOutput.slice(0, 50000) })
        summaryManifest = JSON.stringify({ content: summary.slice(0, 10000) })
      }

      // Insert cargo records
      db.prepare(
        `INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified)
         VALUES (?, ?, ?, 'documentation_full', ?, 1)`
      ).run(crewId, missionId, this.opts.sectorId, fullManifest)

      db.prepare(
        `INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified)
         VALUES (?, ?, ?, 'documentation_summary', ?, 1)`
      ).run(crewId, missionId, this.opts.sectorId, summaryManifest)

      // Update mission
      db.prepare(
        "UPDATE missions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?"
      ).run(resultMsg, missionId)

      // Send comms
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
      ).run(crewId, JSON.stringify({
        missionId, status: 'completed', reason: resultMsg, cargoProduced: true
      }))

      // Log exit
      db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
        crewId,
        JSON.stringify({ status: 'complete', reason: resultMsg })
      )
    } else {
      // Code mission: Genuine failure — no work produced
      db.prepare(
        "UPDATE missions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
      ).run('No work produced', missionId)
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
      ).run(crewId, JSON.stringify({ missionId, status: 'failed', reason: 'No work produced' }))
      db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
        crewId,
        JSON.stringify({ status: 'error', reason: 'No work produced' })
      )
      overrideStatus = 'error'
    }
  } else {
    // Intentional recall with no changes: mark mission as aborted
    db.prepare(
      "UPDATE missions SET status = 'aborted', completed_at = datetime('now') WHERE id = ?"
    ).run(missionId)
  }
  return
}
```

Note: You also need to add `mkdirSync` and `writeFileSync` to the existing import from `'fs'` at the top of hull.ts — they are already imported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/hull.test.ts`
Expected: ALL PASS (both new research tests and all existing tests)

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/hull.ts src/main/__tests__/hull.test.ts
git commit -m "feat(starbase): research missions produce cargo instead of erroring on no changes"
```

---

### Task 5: Final Integration Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Build the project**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit (if any type fixes needed)**

Only if step 2 or 3 required fixes:
```bash
git add -A
git commit -m "fix(starbase): resolve type errors from research missions feature"
```
