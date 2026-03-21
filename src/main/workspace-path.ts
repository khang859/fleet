import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

type BootstrapWorkspaceOptions = {
  cwd?: string | null
  pwd?: string | null
  isPackaged: boolean
  homeDir?: string
}

function normalizePath(candidate?: string | null): string | null {
  if (!candidate) return null

  const trimmed = candidate.trim()
  if (!trimmed) return null

  return isAbsolute(trimmed) ? resolve(trimmed) : null
}

export function resolveBootstrapWorkspacePath(options: BootstrapWorkspaceOptions): string {
  const homeDir = options.homeDir ?? homedir()
  const normalizedCwd = normalizePath(options.cwd)

  if (normalizedCwd && normalizedCwd !== '/') {
    return normalizedCwd
  }

  const normalizedPwd = normalizePath(options.pwd)
  if (normalizedPwd && normalizedPwd !== '/') {
    return normalizedPwd
  }

  if (!options.isPackaged && normalizedCwd) {
    return normalizedCwd
  }

  return homeDir
}
