import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const FLEET_INTEGRATION_VERSION = 1;

/** Returns the absolute path to the installed `fleet` CLI, or null if not found. */
export function resolveFleetBin(): string | null {
  const candidate = join(homedir(), '.fleet', 'bin', 'fleet');
  return existsSync(candidate) ? candidate : null;
}

export type SupportedAgent = 'claude' | 'codex' | 'opencode';

export const SUPPORTED_AGENTS: readonly SupportedAgent[] = ['claude', 'codex', 'opencode'];

export function isSupportedAgent(s: string): s is SupportedAgent {
  return (SUPPORTED_AGENTS as readonly string[]).includes(s);
}
