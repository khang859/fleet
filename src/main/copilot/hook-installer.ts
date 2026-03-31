import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../logger';

const log = createLogger('copilot:hooks');

const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');

// Old Python script name — used for cleanup during migration
const LEGACY_SCRIPT_NAME = 'fleet-copilot.py';

function getHookBinaryName(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  let arch: string;
  switch (process.arch) {
    case 'arm64':
      arch = 'arm64';
      break;
    case 'x64':
    default:
      arch = 'amd64';
      break;
  }
  const name = `fleet-copilot-${platform}-${arch}`;
  return platform === 'windows' ? `${name}.exe` : name;
}

const HOOK_BINARY_NAME = getHookBinaryName();

function resolvePaths(configDir?: string): {
  claudeDir: string;
  hooksDir: string;
  settingsPath: string;
  hookDest: string;
} {
  const claudeDir = configDir || DEFAULT_CLAUDE_DIR;
  const hooksDir = join(claudeDir, 'hooks');
  const settingsPath = join(claudeDir, 'settings.json');
  const hookDest = join(hooksDir, HOOK_BINARY_NAME);
  return { claudeDir, hooksDir, settingsPath, hookDest };
}

type HookEntry = {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
};

type ClaudeSettings = {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
};

function buildHookEntries(command: string): Record<string, HookEntry[]> {
  const simpleHook = (timeout?: number): HookEntry => ({
    hooks: [{ type: 'command', command, ...(timeout != null ? { timeout } : {}) }],
  });

  const matcherHook = (matcher: string, timeout?: number): HookEntry => ({
    matcher,
    hooks: [{ type: 'command', command, ...(timeout != null ? { timeout } : {}) }],
  });

  return {
    UserPromptSubmit: [simpleHook()],
    PreToolUse: [matcherHook('*')],
    PostToolUse: [matcherHook('*')],
    PermissionRequest: [matcherHook('*', 86400)],
    Notification: [matcherHook('*')],
    Stop: [simpleHook()],
    SubagentStop: [simpleHook()],
    SessionStart: [simpleHook()],
    SessionEnd: [simpleHook()],
    PreCompact: [matcherHook('auto'), matcherHook('manual')],
  };
}

function hasFleetHook(entries: HookEntry[]): boolean {
  return entries.some((entry) =>
    entry.hooks.some(
      (h) => h.command.includes(HOOK_BINARY_NAME) || h.command.includes(LEGACY_SCRIPT_NAME)
    )
  );
}

export function getHookBinarySourcePath(): string {
  // Dev: hooks/bin/<binary>
  const devPath = join(process.cwd(), 'hooks', 'bin', HOOK_BINARY_NAME);
  if (existsSync(devPath)) return devPath;

  // Production: resources/hooks/<binary>
  const resourcesPath = join(process.resourcesPath ?? '', 'hooks', HOOK_BINARY_NAME);
  if (existsSync(resourcesPath)) return resourcesPath;

  return devPath; // fallback
}

function removeLegacyHooks(configDir?: string): void {
  const { hooksDir, settingsPath } = resolvePaths(configDir);

  // Remove old Python script
  const legacyDest = join(hooksDir, LEGACY_SCRIPT_NAME);
  if (existsSync(legacyDest)) {
    try {
      unlinkSync(legacyDest);
      log.info('removed legacy Python hook script');
    } catch {
      log.warn('failed to remove legacy hook script');
    }
  }

  // Remove old Python hook entries from settings.json
  if (!existsSync(settingsPath)) return;
  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks ?? {};
    let changed = false;

    for (const eventName of Object.keys(hooks)) {
      const before = hooks[eventName]?.length ?? 0;
      hooks[eventName] = (hooks[eventName] ?? []).filter(
        (entry) => !entry.hooks.some((h) => h.command.includes(LEGACY_SCRIPT_NAME))
      );
      if ((hooks[eventName]?.length ?? 0) < before) changed = true;
      if (hooks[eventName]?.length === 0) {
        delete hooks[eventName];
      }
    }

    if (changed) {
      settings.hooks = hooks;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      log.info('removed legacy Python hook entries from settings.json');
    }
  } catch {
    log.warn('failed to clean legacy hook entries');
  }
}

export function syncScript(configDir?: string): void {
  const { hooksDir, hookDest } = resolvePaths(configDir);

  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const source = getHookBinarySourcePath();
  if (!existsSync(source)) {
    log.warn('hook binary source not found, skipping sync', { source });
    return;
  }

  try {
    if (existsSync(hookDest)) {
      const srcContent = readFileSync(source);
      const destContent = readFileSync(hookDest);
      if (srcContent.equals(destContent)) return;
    }

    copyFileSync(source, hookDest);
    chmodSync(hookDest, 0o755);
    log.info('hook binary synced', { dest: hookDest });
  } catch (err) {
    log.error('failed to sync hook binary', { error: String(err) });
  }
}

export function isInstalled(configDir?: string): boolean {
  const { settingsPath, hookDest } = resolvePaths(configDir);

  if (!existsSync(hookDest)) return false;
  if (!existsSync(settingsPath)) return false;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks ?? {};
    return 'SessionStart' in hooks && hasFleetHook(hooks['SessionStart'] ?? []);
  } catch {
    return false;
  }
}

export function install(configDir?: string): void {
  log.info('installing hooks');
  const { hooksDir, settingsPath, hookDest } = resolvePaths(configDir);

  // Clean up legacy Python hooks first
  removeLegacyHooks(configDir);

  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const source = getHookBinarySourcePath();
  if (!existsSync(source)) {
    log.error('hook binary source not found', { source });
    throw new Error(`Hook binary not found: ${source}`);
  }
  try {
    copyFileSync(source, hookDest);
    chmodSync(hookDest, 0o755);
    log.info('hook binary installed', { dest: hookDest });
  } catch (err) {
    log.error('failed to copy/chmod hook binary', { error: String(err) });
    throw new Error(`Failed to install hook binary: ${String(err)}`);
  }

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      log.warn('failed to parse existing settings.json, starting fresh');
    }
  }

  const command = hookDest;
  const newEntries = buildHookEntries(command);

  const existingHooks = settings.hooks ?? {};

  for (const [eventName, entries] of Object.entries(newEntries)) {
    const existing = existingHooks[eventName] ?? [];
    if (!hasFleetHook(existing)) {
      existingHooks[eventName] = [...existing, ...entries];
    }
  }

  settings.hooks = existingHooks;
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    log.info('settings.json updated');
  } catch (err) {
    log.error('failed to write settings.json', { error: String(err) });
    throw new Error(`Failed to update settings.json: ${String(err)}`);
  }
}

export function uninstall(configDir?: string): void {
  log.info('uninstalling hooks');
  const { hooksDir, settingsPath, hookDest } = resolvePaths(configDir);

  if (existsSync(hookDest)) {
    try {
      unlinkSync(hookDest);
    } catch {
      log.warn('failed to remove hook binary');
    }
  }

  // Also clean up legacy Python script if present
  const legacyDest = join(hooksDir, LEGACY_SCRIPT_NAME);
  if (existsSync(legacyDest)) {
    try {
      unlinkSync(legacyDest);
    } catch {
      // ignore
    }
  }

  if (!existsSync(settingsPath)) return;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks ?? {};

    for (const eventName of Object.keys(hooks)) {
      hooks[eventName] = (hooks[eventName] ?? []).filter(
        (entry) =>
          !entry.hooks.some(
            (h) => h.command.includes(HOOK_BINARY_NAME) || h.command.includes(LEGACY_SCRIPT_NAME)
          )
      );
      if (hooks[eventName].length === 0) {
        delete hooks[eventName];
      }
    }

    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    log.info('settings.json cleaned');
  } catch {
    log.warn('failed to clean settings.json');
  }
}
