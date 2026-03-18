import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import type { PtyManager } from '../pty-manager'
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
  private onStatusChange: ((status: AdmiralStatus, error?: string) => void) | null = null

  constructor(opts: AdmiralProcessOpts) {
    this.workspace = opts.workspace
    this.starbaseName = opts.starbaseName
    this.sectors = opts.sectors
    this.ptyManager = opts.ptyManager
    this.fleetBinPath = opts.fleetBinPath
  }

  setOnStatusChange(listener: (status: AdmiralStatus, error?: string) => void): void {
    this.onStatusChange = listener
  }

  updateSectors(sectors: SectorInfo[]): void {
    this.sectors = sectors
  }

  private notify(status: AdmiralStatus, error?: string): void {
    this.status = status
    if (this.onStatusChange) {
      this.onStatusChange(status, error)
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

    // 5. Always overwrite settings
    const settingsPath = path.join(this.workspace, '.claude', 'settings.json')
    fs.writeFileSync(settingsPath, generateSettings(), 'utf-8')
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

      this.ptyManager.onExit(paneId, () => {
        this.paneId = null
        this.notify('stopped')
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
}
