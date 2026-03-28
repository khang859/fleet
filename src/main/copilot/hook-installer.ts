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

const CLAUDE_DIR = join(homedir(), '.claude');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

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
const HOOK_DEST = join(HOOKS_DIR, HOOK_BINARY_NAME);

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

function removeLegacyHooks(): void {
  // Remove old Python script
  const legacyDest = join(HOOKS_DIR, LEGACY_SCRIPT_NAME);
  if (existsSync(legacyDest)) {
    try {
      unlinkSync(legacyDest);
      log.info('removed legacy Python hook script');
    } catch {
      log.warn('failed to remove legacy hook script');
    }
  }

  // Remove old Python hook entries from settings.json
  if (!existsSync(SETTINGS_PATH)) return;
  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
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
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
      log.info('removed legacy Python hook entries from settings.json');
    }
  } catch {
    log.warn('failed to clean legacy hook entries');
  }
}

export function syncScript(): void {
  if (!existsSync(HOOKS_DIR)) mkdirSync(HOOKS_DIR, { recursive: true });

  const source = getHookBinarySourcePath();
  if (!existsSync(source)) return;

  if (existsSync(HOOK_DEST)) {
    const srcContent = readFileSync(source);
    const destContent = readFileSync(HOOK_DEST);
    if (srcContent.equals(destContent)) return;
  }

  copyFileSync(source, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  log.info('hook binary synced', { dest: HOOK_DEST });
}

export function isInstalled(): boolean {
  if (!existsSync(HOOK_DEST)) return false;
  if (!existsSync(SETTINGS_PATH)) return false;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const hooks = settings.hooks ?? {};
    return 'SessionStart' in hooks && hasFleetHook(hooks['SessionStart'] ?? []);
  } catch {
    return false;
  }
}

export function install(): void {
  log.info('installing hooks');

  // Clean up legacy Python hooks first
  removeLegacyHooks();

  if (!existsSync(HOOKS_DIR)) mkdirSync(HOOKS_DIR, { recursive: true });

  const source = getHookBinarySourcePath();
  if (!existsSync(source)) {
    log.error('hook binary source not found', { source });
    throw new Error(`Hook binary not found: ${source}`);
  }
  copyFileSync(source, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  log.info('hook binary installed', { dest: HOOK_DEST });

  let settings: ClaudeSettings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch {
      log.warn('failed to parse existing settings.json, starting fresh');
    }
  }

  const command = HOOK_DEST;
  const newEntries = buildHookEntries(command);

  const existingHooks = settings.hooks ?? {};

  for (const [eventName, entries] of Object.entries(newEntries)) {
    const existing = existingHooks[eventName] ?? [];
    if (!hasFleetHook(existing)) {
      existingHooks[eventName] = [...existing, ...entries];
    }
  }

  settings.hooks = existingHooks;
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  log.info('settings.json updated');
}

export function uninstall(): void {
  log.info('uninstalling hooks');

  if (existsSync(HOOK_DEST)) {
    try {
      unlinkSync(HOOK_DEST);
    } catch {
      log.warn('failed to remove hook binary');
    }
  }

  // Also clean up legacy Python script if present
  const legacyDest = join(HOOKS_DIR, LEGACY_SCRIPT_NAME);
  if (existsSync(legacyDest)) {
    try {
      unlinkSync(legacyDest);
    } catch {
      // ignore
    }
  }

  if (!existsSync(SETTINGS_PATH)) return;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
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
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    log.info('settings.json cleaned');
  } catch {
    log.warn('failed to clean settings.json');
  }
}
