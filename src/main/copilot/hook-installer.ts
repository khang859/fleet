import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { createLogger } from '../logger';

const log = createLogger('copilot:hooks');

const CLAUDE_DIR = join(homedir(), '.claude');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const HOOK_SCRIPT_NAME = 'fleet-copilot.py';
const HOOK_DEST = join(HOOKS_DIR, HOOK_SCRIPT_NAME);

function detectPython(): string {
  for (const bin of ['python3', 'python']) {
    try {
      execFileSync('which', [bin], { encoding: 'utf-8' });
      return bin;
    } catch {
      // not found
    }
  }
  return 'python3';
}

function makeHookCommand(python: string): string {
  return `${python} ${HOOK_DEST}`;
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
    entry.hooks.some((h) => h.command.includes(HOOK_SCRIPT_NAME))
  );
}

export function getHookScriptSourcePath(): string {
  const devPath = join(process.cwd(), 'hooks', HOOK_SCRIPT_NAME);
  if (existsSync(devPath)) return devPath;

  const resourcesPath = join(process.resourcesPath ?? '', 'hooks', HOOK_SCRIPT_NAME);
  if (existsSync(resourcesPath)) return resourcesPath;

  return devPath; // fallback
}

export function syncScript(): void {
  if (!existsSync(HOOKS_DIR)) mkdirSync(HOOKS_DIR, { recursive: true });

  const source = getHookScriptSourcePath();
  if (!existsSync(source)) return;

  // Skip if already up to date
  if (existsSync(HOOK_DEST)) {
    const srcContent = readFileSync(source);
    const destContent = readFileSync(HOOK_DEST);
    if (srcContent.equals(destContent)) return;
  }

  copyFileSync(source, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  log.info('hook script synced', { dest: HOOK_DEST });
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

  if (!existsSync(HOOKS_DIR)) mkdirSync(HOOKS_DIR, { recursive: true });

  const source = getHookScriptSourcePath();
  if (!existsSync(source)) {
    log.error('hook script source not found', { source });
    throw new Error(`Hook script not found: ${source}`);
  }
  copyFileSync(source, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  log.info('hook script installed', { dest: HOOK_DEST });

  let settings: ClaudeSettings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch {
      log.warn('failed to parse existing settings.json, starting fresh');
    }
  }

  const python = detectPython();
  const command = makeHookCommand(python);
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
      log.warn('failed to remove hook script');
    }
  }

  if (!existsSync(SETTINGS_PATH)) return;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const hooks = settings.hooks ?? {};

    for (const eventName of Object.keys(hooks)) {
      hooks[eventName] = (hooks[eventName] ?? []).filter(
        (entry) => !entry.hooks.some((h) => h.command.includes(HOOK_SCRIPT_NAME))
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
