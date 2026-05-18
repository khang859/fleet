import type { SupportedAgent } from './shared';
import { SUPPORTED_AGENTS, isSupportedAgent } from './shared';

export { SUPPORTED_AGENTS, isSupportedAgent };
export type { SupportedAgent };

export type InstallStatus = { installed: boolean; version: number | null; path?: string };

export async function install(agent: SupportedAgent): Promise<void> {
  switch (agent) {
    case 'claude': {
      const m = await import('./claude-installer');
      return m.install();
    }
    case 'codex': {
      const m = await import('./codex-installer');
      return m.install();
    }
    case 'opencode': {
      const m = await import('./opencode-installer');
      return m.install();
    }
  }
}

export async function uninstall(agent: SupportedAgent): Promise<void> {
  switch (agent) {
    case 'claude': {
      const m = await import('./claude-installer');
      return m.uninstall();
    }
    case 'codex': {
      const m = await import('./codex-installer');
      return m.uninstall();
    }
    case 'opencode': {
      const m = await import('./opencode-installer');
      return m.uninstall();
    }
  }
}

export async function status(agent: SupportedAgent): Promise<InstallStatus> {
  switch (agent) {
    case 'claude': {
      const m = await import('./claude-installer');
      return m.status();
    }
    case 'codex': {
      const m = await import('./codex-installer');
      return m.status();
    }
    case 'opencode': {
      const m = await import('./opencode-installer');
      return m.status();
    }
  }
}
