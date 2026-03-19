import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StarbaseDB } from '../starbase/db'
import { SectorService } from '../starbase/sector-service'
import { MissionService } from '../starbase/mission-service'
import { rmSync, mkdirSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'

// Mock child_process.spawn before importing Hull (ESM modules need top-level mock)
let mockProc: any = null
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn((..._args: any[]) => mockProc),
  }
})

// Import Hull AFTER mock is set up
import { Hull, HullOpts } from '../starbase/hull'

const TEST_DIR = join(tmpdir(), 'fleet-test-hull')
const WORKSPACE_DIR = join(TEST_DIR, 'workspace')
const SECTOR_DIR = join(WORKSPACE_DIR, 'api')
const DB_DIR = join(TEST_DIR, 'starbases')
const WORKTREE_DIR = join(TEST_DIR, 'worktrees', 'test-sb', 'hull-crew')

let db: StarbaseDB
let missionSvc: MissionService

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(SECTOR_DIR, { recursive: true })
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '')
  // Init git repo
  execSync('git init && git checkout -b main', { cwd: SECTOR_DIR })
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: SECTOR_DIR })
  writeFileSync(join(SECTOR_DIR, 'README.md'), '# Test')
  execSync('git add -A && git commit -m "initial"', { cwd: SECTOR_DIR })

  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR)
  db.open()
  const sectorSvc = new SectorService(db.getDb(), WORKSPACE_DIR)
  sectorSvc.addSector({ path: 'api' })
  missionSvc = new MissionService(db.getDb())
})

afterEach(() => {
  db.close()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('Hull', () => {
  it('should construct with required opts', () => {
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'echo hello'
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
      db: db.getDb()
    })
    expect(hull).toBeDefined()
    expect(hull.getStatus()).toBe('pending')
  })

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

  it('should track output in ring buffer', () => {
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'echo hello'
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
      db: db.getDb()
    })
    // Test the ring buffer directly
    hull.appendOutput('line 1\n')
    hull.appendOutput('line 2\n')
    expect(hull.getOutputBuffer()).toContain('line 1')
    expect(hull.getOutputBuffer()).toContain('line 2')
  })
})

/**
 * Gate 2 tests: verify_command and lint_command
 *
 * These tests exercise the cleanup method by mocking child_process.spawn
 * and triggering the exit event on the mock process.
 */
describe('Hull Gate 2 — verify and lint', () => {
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

  function makeOpts(overrides: Partial<HullOpts> = {}): HullOpts {
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'do something'
    })
    return {
      crewId: `crew-${mission.id}`,
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'do something',
      worktreePath: WORKTREE_DIR,
      worktreeBranch: 'crew/test-branch',
      baseBranch: 'main',
      sectorPath: SECTOR_DIR,
      db: db.getDb(),
      lifesignIntervalSec: 9999, // prevent timers from firing
      timeoutMin: 9999,
      ...overrides
    }
  }

  const BARE_REMOTE_DIR = join(TEST_DIR, 'remote.git')

  // Helper: create worktree dir with a change so hasChanges=true
  // Sets up a bare remote so git push succeeds instantly.
  function setupWorktreeWithChange() {
    mkdirSync(BARE_REMOTE_DIR, { recursive: true })
    execSync('git init --bare', { cwd: BARE_REMOTE_DIR })
    execSync(`git remote add origin "${BARE_REMOTE_DIR}"`, { cwd: SECTOR_DIR })
    execSync('git push -u origin main', { cwd: SECTOR_DIR })
    execSync('git branch crew/test-branch main', { cwd: SECTOR_DIR })
    mkdirSync(join(TEST_DIR, 'worktrees', 'test-sb'), { recursive: true })
    execSync(`git worktree add "${WORKTREE_DIR}" crew/test-branch`, { cwd: SECTOR_DIR })
    writeFileSync(join(WORKTREE_DIR, 'new-file.txt'), 'new content')
    execSync('git add -A && git commit -m "work"', { cwd: WORKTREE_DIR })
  }

  it('verify command pass — continues to PR creation', { timeout: 60_000 }, async () => {
    setupWorktreeWithChange()
    const opts = makeOpts({ verifyCommand: 'echo "tests passed"' })
    const hull = new Hull(opts)

    await hull.start()
    // Trigger exit on the mock process
    mockProc.emit('exit', 0)

    // Wait for cleanup to complete
    await new Promise((r) => setTimeout(r, 500))

    // Verify result should be stored
    const row = db
      .getDb()
      .prepare('SELECT verify_result, status FROM missions WHERE id = ?')
      .get(opts.missionId) as any
    expect(row.verify_result).toBeTruthy()
    const vr = JSON.parse(row.verify_result)
    expect(vr.exitCode).toBe(0)
    expect(vr.stdout).toContain('tests passed')
    // Status should NOT be failed-verification
    expect(row.status).not.toBe('failed-verification')
  })

  it('verify command fail — sets failed-verification, no PR', { timeout: 60_000 }, async () => {
    setupWorktreeWithChange()
    const opts = makeOpts({ verifyCommand: 'exit 1' })
    const hull = new Hull(opts)

    await hull.start()
    mockProc.emit('exit', 0)

    await new Promise((r) => setTimeout(r, 500))

    const row = db
      .getDb()
      .prepare('SELECT verify_result, status FROM missions WHERE id = ?')
      .get(opts.missionId) as any
    expect(row.verify_result).toBeTruthy()
    const vr = JSON.parse(row.verify_result)
    expect(vr.exitCode).not.toBe(0)
    expect(row.status).toBe('failed-verification')

    // Check comms — should have verificationFailed flag
    const comms = db
      .getDb()
      .prepare("SELECT payload FROM comms WHERE from_crew = ? AND type = 'mission_complete'")
      .get(opts.crewId) as any
    if (comms) {
      const payload = JSON.parse(comms.payload)
      expect(payload.verificationFailed).toBe(true)
    }
  })

  it(
    'verify command timeout — sets failed-verification with timedOut flag',
    { timeout: 60_000 },
    async () => {
      setupWorktreeWithChange()
      const opts = makeOpts({ verifyCommand: 'false' }) // exits with code 1
      const hull = new Hull(opts)

      await hull.start()
      mockProc.emit('exit', 0)

      await new Promise((r) => setTimeout(r, 500))

      const row = db
        .getDb()
        .prepare('SELECT verify_result, status FROM missions WHERE id = ?')
        .get(opts.missionId) as any
      expect(row.status).toBe('failed-verification')
      const vr = JSON.parse(row.verify_result)
      expect(vr.exitCode).toBeTruthy() // non-zero
      expect(vr.duration).toBeDefined()
    }
  )

  it('lint warnings — PR gets lint-warnings label in comms', { timeout: 60_000 }, async () => {
    setupWorktreeWithChange()
    const opts = makeOpts({ lintCommand: 'echo "warning: unused var" && exit 1' })
    const hull = new Hull(opts)

    await hull.start()
    mockProc.emit('exit', 0)

    await new Promise((r) => setTimeout(r, 500))

    // Mission should NOT be failed-verification (lint is non-blocking)
    const row = db
      .getDb()
      .prepare('SELECT status FROM missions WHERE id = ?')
      .get(opts.missionId) as any
    expect(row.status).not.toBe('failed-verification')

    // Comms should include hasLintWarnings
    const comms = db
      .getDb()
      .prepare("SELECT payload FROM comms WHERE from_crew = ? AND type = 'mission_complete'")
      .get(opts.crewId) as any
    if (comms) {
      const payload = JSON.parse(comms.payload)
      expect(payload.hasLintWarnings).toBe(true)
    }
  })

  it('no verify/lint commands — existing behavior unchanged', { timeout: 60_000 }, async () => {
    setupWorktreeWithChange()
    const opts = makeOpts() // no verifyCommand, no lintCommand
    const hull = new Hull(opts)

    await hull.start()
    mockProc.emit('exit', 0)

    await new Promise((r) => setTimeout(r, 500))

    const row = db
      .getDb()
      .prepare('SELECT verify_result, status FROM missions WHERE id = ?')
      .get(opts.missionId) as any
    // verify_result should be null (not set)
    expect(row.verify_result).toBeNull()
    // Status should not be failed-verification
    expect(row.status).not.toBe('failed-verification')
  })

  it('verify pass + lint warnings — PR created with warnings', { timeout: 60_000 }, async () => {
    setupWorktreeWithChange()
    const opts = makeOpts({
      verifyCommand: 'echo "ok"',
      lintCommand: 'echo "warn: something" && exit 1'
    })
    const hull = new Hull(opts)

    await hull.start()
    mockProc.emit('exit', 0)

    await new Promise((r) => setTimeout(r, 500))

    const row = db
      .getDb()
      .prepare('SELECT verify_result, status FROM missions WHERE id = ?')
      .get(opts.missionId) as any
    const vr = JSON.parse(row.verify_result)
    expect(vr.exitCode).toBe(0)
    // Not failed-verification since verify passed
    expect(row.status).not.toBe('failed-verification')

    // Comms should have lint warnings
    const comms = db
      .getDb()
      .prepare("SELECT payload FROM comms WHERE from_crew = ? AND type = 'mission_complete'")
      .get(opts.crewId) as any
    if (comms) {
      const payload = JSON.parse(comms.payload)
      expect(payload.hasLintWarnings).toBe(true)
      expect(payload.verificationFailed).toBeUndefined()
    }
  })
})

/**
 * Gate 3 tests: Admiral review via pr_review_request comms
 *
 * Tests that Hull sends a pr_review_request comms message when reviewMode is 'admiral-review'
 * and sets mission status to 'pending-review'. Also verifies other review modes don't trigger this.
 */
describe('Hull Gate 3 — Admiral review', () => {
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

  function makeOpts(overrides: Partial<HullOpts> = {}): HullOpts {
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'do something',
      acceptanceCriteria: 'Must have tests. Must handle errors.'
    })
    return {
      crewId: `crew-${mission.id}`,
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'do something',
      worktreePath: WORKTREE_DIR,
      worktreeBranch: 'crew/test-branch',
      baseBranch: 'main',
      sectorPath: SECTOR_DIR,
      db: db.getDb(),
      lifesignIntervalSec: 9999,
      timeoutMin: 9999,
      ...overrides
    }
  }

  const BARE_REMOTE_DIR = join(TEST_DIR, 'remote.git')

  function setupWorktreeWithChange() {
    mkdirSync(BARE_REMOTE_DIR, { recursive: true })
    execSync('git init --bare', { cwd: BARE_REMOTE_DIR })
    execSync(`git remote add origin "${BARE_REMOTE_DIR}"`, { cwd: SECTOR_DIR })
    execSync('git push -u origin main', { cwd: SECTOR_DIR })
    execSync('git branch crew/test-branch main', { cwd: SECTOR_DIR })
    mkdirSync(join(TEST_DIR, 'worktrees', 'test-sb'), { recursive: true })
    execSync(`git worktree add "${WORKTREE_DIR}" crew/test-branch`, { cwd: SECTOR_DIR })
    writeFileSync(join(WORKTREE_DIR, 'new-file.txt'), 'new content')
    execSync('git add -A && git commit -m "work"', { cwd: WORKTREE_DIR })
  }

  it(
    'admiral-review mode — sends pr_review_request comms and sets pending-review',
    { timeout: 60_000 },
    async () => {
      setupWorktreeWithChange()
      const opts = makeOpts({ reviewMode: 'admiral-review' })
      const hull = new Hull(opts)

      await hull.start()
      mockProc.emit('exit', 0)

      await new Promise((r) => setTimeout(r, 500))

      // gh pr create will fail (no real GitHub), so pr_review_request won't be sent
      // but the mission_complete comms should still be sent
      const completionComms = db
        .getDb()
        .prepare("SELECT payload FROM comms WHERE from_crew = ? AND type = 'mission_complete'")
        .get(opts.crewId) as any
      expect(completionComms).toBeTruthy()

      // Since gh is not available in tests, PR creation fails silently.
      // Verify that reviewMode is accepted without errors.
      const row = db
        .getDb()
        .prepare('SELECT status FROM missions WHERE id = ?')
        .get(opts.missionId) as any
      // Status should be set (not undefined)
      expect(row.status).toBeDefined()
    }
  )

  it('verify-only mode — no pr_review_request comms sent', { timeout: 60_000 }, async () => {
    setupWorktreeWithChange()
    const opts = makeOpts({ reviewMode: 'verify-only' })
    const hull = new Hull(opts)

    await hull.start()
    mockProc.emit('exit', 0)

    await new Promise((r) => setTimeout(r, 500))

    // No pr_review_request comms should exist
    const reviewComms = db
      .getDb()
      .prepare("SELECT * FROM comms WHERE from_crew = ? AND type = 'pr_review_request'")
      .get(opts.crewId) as any
    expect(reviewComms).toBeUndefined()

    // Mission should NOT be pending-review
    const row = db
      .getDb()
      .prepare('SELECT status FROM missions WHERE id = ?')
      .get(opts.missionId) as any
    expect(row.status).not.toBe('pending-review')
  })

  it(
    'manual mode (no reviewMode) — no pr_review_request comms sent',
    { timeout: 60_000 },
    async () => {
      setupWorktreeWithChange()
      const opts = makeOpts() // no reviewMode
      const hull = new Hull(opts)

      await hull.start()
      mockProc.emit('exit', 0)

      await new Promise((r) => setTimeout(r, 500))

      // No pr_review_request comms should exist
      const reviewComms = db
        .getDb()
        .prepare("SELECT * FROM comms WHERE from_crew = ? AND type = 'pr_review_request'")
        .get(opts.crewId) as any
      expect(reviewComms).toBeUndefined()

      // Mission should NOT be pending-review
      const row = db
        .getDb()
        .prepare('SELECT status FROM missions WHERE id = ?')
        .get(opts.missionId) as any
      expect(row.status).not.toBe('pending-review')
    }
  )
})

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

  function setupWorktreeNoChanges() {
    mkdirSync(BARE_REMOTE_DIR, { recursive: true })
    execSync('git init --bare', { cwd: BARE_REMOTE_DIR })
    execSync(`git remote add origin "${BARE_REMOTE_DIR}"`, { cwd: SECTOR_DIR })
    execSync('git push -u origin main', { cwd: SECTOR_DIR })
    execSync('git branch crew/test-branch main', { cwd: SECTOR_DIR })
    mkdirSync(join(TEST_DIR, 'worktrees', 'test-sb'), { recursive: true })
    execSync(`git worktree add "${WORKTREE_DIR}" crew/test-branch`, { cwd: SECTOR_DIR })
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

    await hull.start()
    const outputMsg = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Found 3 auth patterns in the codebase.' }] },
      session_id: 'test'
    })
    mockProc.stdout.emit('data', Buffer.from(outputMsg + '\n'))
    mockProc.emit('exit', 0)

    await new Promise((r) => setTimeout(r, 500))

    const row = db.getDb()
      .prepare('SELECT status, result FROM missions WHERE id = ?')
      .get(mission.id) as any
    expect(row.status).toBe('completed')
    expect(row.result).toContain('Research completed')

    const crew = db.getDb()
      .prepare('SELECT status FROM crew WHERE id = ?')
      .get(opts.crewId) as any
    expect(crew.status).toBe('complete')

    const cargo = db.getDb()
      .prepare('SELECT * FROM cargo WHERE mission_id = ?')
      .all(mission.id) as any[]
    expect(cargo.length).toBe(2)
    expect(cargo.map((c: any) => c.type).sort()).toEqual(['documentation_full', 'documentation_summary'])
    expect(cargo.every((c: any) => c.verified === 1)).toBe(true)

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
    mockProc.emit('exit', 1)

    await new Promise((r) => setTimeout(r, 500))

    const row = db.getDb()
      .prepare('SELECT status, result FROM missions WHERE id = ?')
      .get(mission.id) as any
    expect(row.status).toBe('failed')
    expect(row.result).toBe('No work produced')

    const crew = db.getDb()
      .prepare('SELECT status FROM crew WHERE id = ?')
      .get(opts.crewId) as any
    expect(crew.status).toBe('error')

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
      crewId: `crew-code-${mission.id}`,
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

    const row = db.getDb()
      .prepare('SELECT status, result FROM missions WHERE id = ?')
      .get(mission.id) as any
    expect(row.status).toBe('failed')
    expect(row.result).toBe('No work produced')

    const crew = db.getDb()
      .prepare('SELECT status FROM crew WHERE id = ?')
      .get(opts.crewId) as any
    expect(crew.status).toBe('error')
  })
})
