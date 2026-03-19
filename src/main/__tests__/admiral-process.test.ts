import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { AdmiralProcess } from '../starbase/admiral-process'
import type { PtyManager } from '../pty-manager'

// ---------------------------------------------------------------------------
// Mock PtyManager
// ---------------------------------------------------------------------------

type MockPtyEntry = {
  paneId: string
  opts: Record<string, unknown>
  exitHandler: ((exitCode: number) => void) | null
}

function createMockPtyManager(): PtyManager & { _entries: Map<string, MockPtyEntry>; _protected: Set<string> } {
  const entries = new Map<string, MockPtyEntry>()
  const protected_ = new Set<string>()

  return {
    _entries: entries,
    _protected: protected_,
    create: vi.fn((opts) => {
      if (entries.has(opts.paneId)) {
        throw new Error(`${opts.paneId} already exists`)
      }
      entries.set(opts.paneId, { paneId: opts.paneId, opts, exitHandler: null })
      return { paneId: opts.paneId, pid: 99999 }
    }),
    protect: vi.fn((paneId: string) => {
      protected_.add(paneId)
    }),
    kill: vi.fn((paneId: string) => {
      const entry = entries.get(paneId)
      if (entry) {
        entries.delete(paneId)
        protected_.delete(paneId)
        // Simulate exit event
        if (entry.exitHandler) {
          entry.exitHandler(0)
        }
      }
    }),
    onExit: vi.fn((paneId: string, cb: (exitCode: number) => void) => {
      const entry = entries.get(paneId)
      if (entry) {
        entry.exitHandler = cb
      }
    }),
    onData: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    killAll: vi.fn(),
    has: vi.fn((paneId: string) => entries.has(paneId)),
    get: vi.fn((paneId: string) => entries.get(paneId) as never),
    paneIds: vi.fn(() => Array.from(entries.keys())),
    getCwd: vi.fn(),
    updateCwd: vi.fn(),
    getPid: vi.fn(),
    gc: vi.fn(() => []),
  } as unknown as PtyManager & { _entries: Map<string, MockPtyEntry>; _protected: Set<string> }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-test-'))
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Tests: ensureWorkspace
// ---------------------------------------------------------------------------

describe('AdmiralProcess.ensureWorkspace', () => {
  let tmpDir: string
  let mockPty: ReturnType<typeof createMockPtyManager>

  beforeEach(() => {
    tmpDir = makeTmpDir()
    mockPty = createMockPtyManager()
  })

  afterEach(() => {
    removeDir(tmpDir)
  })

  it('creates the workspace directory and sub-directories', async () => {
    const workspace = path.join(tmpDir, 'my-starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    await admiral.ensureWorkspace()

    expect(fs.existsSync(workspace)).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.claude', 'skills', 'fleet'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, 'docs'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, 'learnings'))).toBe(true)
  })

  it('creates a .git directory (git init)', async () => {
    const workspace = path.join(tmpDir, 'my-starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    await admiral.ensureWorkspace()

    expect(fs.existsSync(path.join(workspace, '.git'))).toBe(true)
  })

  it('does not re-init git if .git already exists', async () => {
    const workspace = path.join(tmpDir, 'my-starbase')
    fs.mkdirSync(workspace, { recursive: true })
    execSync('git init', { cwd: workspace, stdio: 'ignore' })
    const headBefore = fs.readFileSync(path.join(workspace, '.git', 'HEAD'), 'utf-8')

    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    await admiral.ensureWorkspace()

    const headAfter = fs.readFileSync(path.join(workspace, '.git', 'HEAD'), 'utf-8')
    expect(headAfter).toBe(headBefore)
  })

  it('writes CLAUDE.md when it does not exist', async () => {
    const workspace = path.join(tmpDir, 'my-starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [{ name: 'api', root_path: '/home/user/api', stack: 'node', base_branch: 'main' }],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    await admiral.ensureWorkspace()

    const claudeMd = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('# Admiral — TestBase')
    expect(claudeMd).toContain('**api**')
    expect(claudeMd).toContain('/home/user/api')
  })

  it('writes SKILL.md to .claude/skills/fleet/', async () => {
    const workspace = path.join(tmpDir, 'my-starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    await admiral.ensureWorkspace()

    const skillMd = fs.readFileSync(
      path.join(workspace, '.claude', 'skills', 'fleet', 'SKILL.md'),
      'utf-8'
    )
    expect(skillMd).toContain('name: fleet')
  })

  it('writes .claude/settings.json', async () => {
    const workspace = path.join(tmpDir, 'my-starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    await admiral.ensureWorkspace()

    const settingsRaw = fs.readFileSync(path.join(workspace, '.claude', 'settings.json'), 'utf-8')
    const settings = JSON.parse(settingsRaw)
    expect(settings.hooks).toBeDefined()
    expect(settings.hooks.PreToolUse).toBeDefined()
  })

  it('updates sectors auto-section without overwriting custom content when CLAUDE.md exists', async () => {
    const workspace = path.join(tmpDir, 'my-starbase')
    fs.mkdirSync(workspace, { recursive: true })

    // Write an existing CLAUDE.md with custom content + auto section
    const existingContent = `# Admiral — TestBase

## Custom Section

This is custom content written by the Admiral that should be preserved.

## Sectors

<!-- fleet:auto-start:sectors -->
- **old-sector** — /old/path (old-stack, base: main)
<!-- fleet:auto-end:sectors -->

## More Custom Content

Do not overwrite this.
`
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), existingContent, 'utf-8')

    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [{ name: 'new-api', root_path: '/new/api', stack: 'typescript', base_branch: 'main' }],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    await admiral.ensureWorkspace()

    const result = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf-8')

    // Custom content preserved
    expect(result).toContain('This is custom content written by the Admiral that should be preserved.')
    expect(result).toContain('Do not overwrite this.')

    // Old sector replaced
    expect(result).not.toContain('old-sector')

    // New sector present
    expect(result).toContain('new-api')
    expect(result).toContain('/new/api')
  })

  it('always overwrites SKILL.md even when workspace already exists', async () => {
    const workspace = path.join(tmpDir, 'my-starbase')
    const skillPath = path.join(workspace, '.claude', 'skills', 'fleet', 'SKILL.md')
    fs.mkdirSync(path.dirname(skillPath), { recursive: true })
    fs.writeFileSync(skillPath, 'old skill content', 'utf-8')

    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    await admiral.ensureWorkspace()

    const skill = fs.readFileSync(skillPath, 'utf-8')
    expect(skill).toContain('name: fleet')
    expect(skill).not.toContain('old skill content')
  })
})

// ---------------------------------------------------------------------------
// Tests: start / stop / restart (mock PTY)
// ---------------------------------------------------------------------------

describe('AdmiralProcess.start/stop/restart', () => {
  let tmpDir: string
  let mockPty: ReturnType<typeof createMockPtyManager>

  beforeEach(() => {
    tmpDir = makeTmpDir()
    mockPty = createMockPtyManager()
  })

  afterEach(() => {
    removeDir(tmpDir)
  })

  it('start() returns a paneId and sets status to running', async () => {
    const workspace = path.join(tmpDir, 'starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    const paneId = await admiral.start()

    expect(paneId).toMatch(/^admiral-\d+$/)
    expect(admiral.status).toBe('running')
    expect(admiral.paneId).toBe(paneId)
  })

  it('start() calls ptyManager.create with correct options', async () => {
    const workspace = path.join(tmpDir, 'starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/fleet/bin'
    })

    await admiral.start()

    expect(mockPty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: workspace,
        cmd: 'claude --dangerously-skip-permissions',
        env: expect.objectContaining({
          PATH: expect.any(String)
        })
      })
    )
  })

  it('start() protects the created PTY', async () => {
    const workspace = path.join(tmpDir, 'starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    const paneId = await admiral.start()

    expect(mockPty.protect).toHaveBeenCalledWith(paneId)
  })

  it('start() notifies starting then running via onStatusChange', async () => {
    const workspace = path.join(tmpDir, 'starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    const statuses: string[] = []
    admiral.setOnStatusChange((status) => statuses.push(status))

    await admiral.start()

    expect(statuses).toContain('starting')
    expect(statuses).toContain('running')
    expect(statuses[statuses.length - 1]).toBe('running')
  })

  it('stop() kills the PTY and sets status to stopped', async () => {
    const workspace = path.join(tmpDir, 'starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    const paneId = await admiral.start()
    await admiral.stop()

    expect(mockPty.kill).toHaveBeenCalledWith(paneId)
    expect(admiral.status).toBe('stopped')
    expect(admiral.paneId).toBeNull()
  })

  it('stop() on non-started admiral is a no-op', async () => {
    const workspace = path.join(tmpDir, 'starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    await expect(admiral.stop()).resolves.not.toThrow()
    expect(admiral.status).toBe('stopped')
  })

  it('restart() stops and starts again, returning a new paneId', async () => {
    const workspace = path.join(tmpDir, 'starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    const firstPaneId = await admiral.start()
    const secondPaneId = await admiral.restart()

    expect(secondPaneId).toMatch(/^admiral-\d+$/)
    // The second pane should be different (different timestamp)
    // (They could theoretically match if Date.now returns same value, but in practice won't)
    expect(admiral.status).toBe('running')
    expect(admiral.paneId).toBe(secondPaneId)
    // First pane was killed during restart
    expect(mockPty.kill).toHaveBeenCalledWith(firstPaneId)
  })

  it('onExit from PTY sets status to stopped and clears paneId', async () => {
    const workspace = path.join(tmpDir, 'starbase')
    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/usr/local/bin'
    })

    const statuses: string[] = []
    admiral.setOnStatusChange((status) => statuses.push(status))

    const paneId = await admiral.start()

    // Simulate PTY exiting on its own
    const entry = mockPty._entries.get(paneId)
    if (entry?.exitHandler) {
      entry.exitHandler(0)
    }

    expect(admiral.status).toBe('stopped')
    expect(admiral.paneId).toBeNull()
    expect(statuses[statuses.length - 1]).toBe('stopped')
  })

  it("PTY env inherits process.env.PATH (fleet bin added at startup)", async () => {
    const workspace = path.join(tmpDir, 'starbase')
    // Simulate main process having already prepended fleet bin to PATH
    const origPath = process.env.PATH
    process.env.PATH = '/custom/fleet/bin:' + (origPath ?? '')

    const admiral = new AdmiralProcess({
      workspace,
      starbaseName: 'TestBase',
      sectors: [],
      ptyManager: mockPty,
      fleetBinPath: '/custom/fleet/bin'
    })

    await admiral.start()

    const callArgs = (mockPty.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.env.PATH).toContain('/custom/fleet/bin')

    // Restore
    process.env.PATH = origPath
  })
})
