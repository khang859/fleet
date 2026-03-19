import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { SystemDepResult } from '../shared/ipc-api'

const execAsync = promisify(exec)

const FLEET_BIN = join(homedir(), '.fleet', 'bin', 'fleet')

const CHECKS = [
  {
    name: 'node',
    cmd: 'node --version',
    installHint: 'Install Node.js: https://nodejs.org'
  },
  {
    name: 'claude',
    cmd: 'claude --version',
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
  },
  {
    name: 'fleet',
    cmd: process.platform === 'win32' ? 'where fleet' : `"${FLEET_BIN}" --version`,
    installHint: 'Fleet CLI should be auto-installed. Try restarting Fleet.',
    // Check binary exists before exec to avoid slow timeout
    preCheck: () => process.platform === 'win32' || existsSync(FLEET_BIN)
  }
]

export async function checkSystemDeps(): Promise<SystemDepResult[]> {
  const results: SystemDepResult[] = []

  for (const check of CHECKS) {
    if (check.preCheck && !check.preCheck()) {
      results.push({ name: check.name, found: false, installHint: check.installHint })
      continue
    }

    try {
      const { stdout } = await execAsync(check.cmd, { timeout: 5000 })
      const version = stdout.trim().split('\n')[0]
      results.push({ name: check.name, found: true, version, installHint: check.installHint })
    } catch {
      results.push({ name: check.name, found: false, installHint: check.installHint })
    }
  }

  return results
}
