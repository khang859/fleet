import * as fs from 'fs'
import * as path from 'path'
import { execSync, exec } from 'child_process'
import { promisify } from 'util'
import type { PtyManager } from '../pty-manager'

const execAsync = promisify(exec)

export interface DepCheckResult {
  name: string
  found: boolean
  version?: string
  installHint: string
}

export async function checkDependencies(): Promise<DepCheckResult[]> {
  const checks = [
    {
      name: 'claude',
      cmd: 'which claude',
      installHint: 'Install Claude Code: npm install -g @anthropic-ai/claude-code'
    },
    {
      name: 'git',
      cmd: 'git --version',
      installHint: 'Install Git: https://git-scm.com/downloads'
    },
    {
      name: 'gh',
      cmd: 'gh --version',
      installHint: 'Install GitHub CLI: https://cli.github.com'
    }
  ]

  const results: DepCheckResult[] = []
  for (const check of checks) {
    try {
      const { stdout } = await execAsync(check.cmd)
      const firstLine = stdout.trim().split('\n')[0]
      // 'which' output is just the path, not a version string
      const version = check.cmd.startsWith('which') ? undefined : firstLine
      results.push({ name: check.name, found: true, version, installHint: check.installHint })
    } catch {
      results.push({ name: check.name, found: false, installHint: check.installHint })
    }
  }
  return results
}
import {
  generateClaudeMd,
  generateSkillMd,
  generateSettings,
  updateAutoSection,
  type SectorInfo
} from './workspace-templates'

export type AdmiralStatus = 'running' | 'stopped' | 'starting'

export interface AdmiralProcessOpts {
  workspace: string
  starbaseName: string
  sectors: SectorInfo[]
  ptyManager: PtyManager
  fleetBinPath: string
}

export class AdmiralProcess {
  readonly workspace: string
  paneId: string | null = null
  status: AdmiralStatus = 'stopped'

  private starbaseName: string
  private sectors: SectorInfo[]
  private ptyManager: PtyManager
  private fleetBinPath: string
  private onStatusChange: ((status: AdmiralStatus, error?: string, exitCode?: number) => void) | null = null

  constructor(opts: AdmiralProcessOpts) {
    this.workspace = opts.workspace
    this.starbaseName = opts.starbaseName
    this.sectors = opts.sectors
    this.ptyManager = opts.ptyManager
    this.fleetBinPath = opts.fleetBinPath
  }

  setOnStatusChange(listener: (status: AdmiralStatus, error?: string, exitCode?: number) => void): void {
    this.onStatusChange = listener
  }

  updateSectors(sectors: SectorInfo[]): void {
    this.sectors = sectors
  }

  private notify(status: AdmiralStatus, error?: string, exitCode?: number): void {
    this.status = status
    if (this.onStatusChange) {
      this.onStatusChange(status, error, exitCode)
    }
  }

  async ensureWorkspace(): Promise<void> {
    // 1. Create directory structure
    const dirsToCreate = [
      this.workspace,
      path.join(this.workspace, '.claude', 'skills', 'fleet'),
      path.join(this.workspace, 'docs'),
      path.join(this.workspace, 'learnings')
    ]

    for (const dir of dirsToCreate) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // 2. git init if no .git/
    const gitDir = path.join(this.workspace, '.git')
    if (!fs.existsSync(gitDir)) {
      execSync('git init', { cwd: this.workspace, stdio: 'ignore' })
    }

    // 3. Handle CLAUDE.md
    const claudeMdPath = path.join(this.workspace, 'CLAUDE.md')
    if (fs.existsSync(claudeMdPath)) {
      // Read existing content and update sectors auto-section only
      const existing = fs.readFileSync(claudeMdPath, 'utf-8')
      const sectorLines =
        this.sectors.length > 0
          ? this.sectors
              .map((s) => {
                const stack = s.stack ?? 'unknown stack'
                const base = s.base_branch ?? 'main'
                return `- **${s.name}** — ${s.root_path} (${stack}, base: ${base})`
              })
              .join('\n')
          : '_No sectors registered._'
      const updated = updateAutoSection(existing, 'sectors', sectorLines)
      fs.writeFileSync(claudeMdPath, updated, 'utf-8')
    } else {
      // Write full generated content
      const content = generateClaudeMd({ starbaseName: this.starbaseName, sectors: this.sectors })
      fs.writeFileSync(claudeMdPath, content, 'utf-8')
    }

    // 4. Always overwrite skill file
    const skillPath = path.join(this.workspace, '.claude', 'skills', 'fleet', 'SKILL.md')
    fs.writeFileSync(skillPath, generateSkillMd(), 'utf-8')

    // 5. Always overwrite settings (include fleet bin path so Claude can find the CLI)
    const settingsPath = path.join(this.workspace, '.claude', 'settings.json')
    fs.writeFileSync(settingsPath, generateSettings(this.fleetBinPath), 'utf-8')
  }

  async start(): Promise<string> {
    this.notify('starting')

    try {
      await this.ensureWorkspace()

      const paneId = 'admiral-' + Date.now()

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PATH: this.fleetBinPath + ':' + (process.env.PATH ?? '')
      }

      try {
        this.ptyManager.create({
          paneId,
          cwd: this.workspace,
          cmd: 'claude --dangerously-skip-permissions',
          env
        })
      } catch (err) {
        const isEnoent =
          err instanceof Error &&
          (err.message.includes('ENOENT') || (err as NodeJS.ErrnoException).code === 'ENOENT')
        const errorMsg = isEnoent ? 'Claude Code not found' : (err instanceof Error ? err.message : String(err))
        this.notify('stopped', errorMsg)
        throw new Error(errorMsg)
      }

      this.ptyManager.protect(paneId)

      this.ptyManager.onExit(paneId, (exitCode) => {
        if (this.paneId === null) return
        this.paneId = null
        this.notify('stopped', undefined, exitCode)
      })

      this.paneId = paneId
      this.notify('running')
      return paneId
    } catch (err) {
      // If we already notified stopped (from PTY create failure), don't double-notify
      if (this.status !== 'stopped') {
        const errorMsg = err instanceof Error ? err.message : String(err)
        const isEnoent = errorMsg.includes('ENOENT')
        this.notify('stopped', isEnoent ? 'Claude Code not found' : errorMsg)
      }
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this.paneId) {
      this.ptyManager.kill(this.paneId)
      this.paneId = null
    }
    this.notify('stopped')
  }

  async restart(): Promise<string> {
    await this.stop()
    return this.start()
  }

  /**
   * Stop the Admiral, delete the entire workspace, and restart fresh.
   * This regenerates CLAUDE.md, skills, settings, and re-inits git.
   */
  async reset(): Promise<string> {
    await this.stop()
    fs.rmSync(this.workspace, { recursive: true, force: true })
    return this.start()
  }
}
