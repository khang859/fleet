import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as net from 'net'
import type { SystemDepResult } from '../shared/ipc-api'
import { SOCKET_PATH } from '../shared/constants'

const execAsync = promisify(exec)

const FLEET_BIN = join(homedir(), '.fleet', 'bin', 'fleet')

type CmdCheck = {
  name: string
  cmd: string
  installHint: string
  preCheck?: () => boolean
  fn?: never
}

type FnCheck = {
  name: string
  fn: () => Promise<SystemDepResult>
  cmd?: never
  preCheck?: never
  installHint?: never
}

type Check = CmdCheck | FnCheck

async function checkFleetSock(): Promise<SystemDepResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET_PATH)
    let responded = false

    const fail = () => {
      if (responded) return
      responded = true
      socket.destroy()
      resolve({
        name: 'fleet.sock',
        found: false,
        installHint:
          'Fleet socket is not running. The app may still be starting up — try clicking Retry in a moment.'
      })
    }

    socket.setTimeout(3000)
    socket.on('timeout', fail)
    socket.on('error', fail)

    socket.on('connect', () => {
      socket.write(JSON.stringify({ command: 'ping' }) + '\n')
    })

    let buf = ''
    socket.on('data', (data) => {
      if (responded) return
      buf += data.toString()
      const line = buf.split('\n')[0]
      try {
        const msg = JSON.parse(line)
        if (msg.ok === true && msg.data?.pong === true) {
          responded = true
          socket.destroy()
          const uptime = msg.data.uptime
          const version = uptime !== undefined ? `uptime: ${Math.round(uptime)}s` : undefined
          resolve({ name: 'fleet.sock', found: true, version })
        }
      } catch {
        // keep buffering
      }
    })

    socket.on('close', () => {
      if (!responded) fail()
    })
  })
}

const CHECKS: Check[] = [
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
  },
  {
    name: 'fleet.sock',
    fn: checkFleetSock
  }
]

export async function checkSystemDeps(): Promise<SystemDepResult[]> {
  const results: SystemDepResult[] = []

  for (const check of CHECKS) {
    if (check.fn) {
      results.push(await check.fn())
      continue
    }

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
