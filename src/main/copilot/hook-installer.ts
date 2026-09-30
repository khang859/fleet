import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
  renameSync
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../logger';
import { isRecord } from '../../shared/is-record';
import { isFleetHookCommand, quoteHookCommand } from '../../shared/claude-hooks';

const log = createLogger('copilot:hooks');

const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');

// Old Python script name — used for cleanup during migration
const LEGACY_SCRIPT_NAME = 'fleet-copilot.py';

/** Why an install refused to touch the user's settings file. */
export class UnreadableSettingsError extends Error {
  constructor(
    readonly settingsPath: string,
    detail: string
  ) {
    super(
      `Claude settings at ${settingsPath} could not be read (${detail}). ` +
        'Fleet left the file unchanged. Fix or remove it, then try again.'
    );
    this.name = 'UnreadableSettingsError';
  }
}

/**
 * The settings object on disk, or `{}` when there is no file yet.
 *
 * Throws rather than falling back to `{}` when the file exists but is not a
 * JSON object: writing back from `{}` would erase every setting the user has.
 */
function readSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};
  const text = readFileSync(settingsPath, 'utf-8');
  if (text.trim() === '') return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new UnreadableSettingsError(settingsPath, `invalid JSON: ${String(err)}`);
  }
  if (!isRecord(data)) throw new UnreadableSettingsError(settingsPath, 'not a JSON object');
  return data;
}

/**
 * Replace the settings file, keeping the previous version as a backup.
 *
 * The write lands in a temp file beside the target and is renamed over it, so
 * an interrupted write never leaves a truncated settings file behind.
 */
function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.fleet-bak`);
  const tmp = `${settingsPath}.fleet-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
    renameSync(tmp, settingsPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
}

/**
 * Whether Fleet wrote this entry. Legacy Python entries ran `python3 <path>`,
 * so the executable-head match misses them and they are matched by script name.
 */
function isFleetEntry(entry: unknown): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) =>
      isRecord(h) &&
      typeof h.command === 'string' &&
      (isFleetHookCommand(h.command) || h.command.includes(LEGACY_SCRIPT_NAME))
  );
}

/**
 * `hooks` with every Fleet entry removed, dropping events that only Fleet used.
 *
 * Anything that is not the shape Fleet expects belongs to the user or to a
 * newer Claude Code, so it is carried through untouched rather than dropped.
 */
function withoutFleetHooks(hooks: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      kept[eventName] = entries;
      continue;
    }
    const userEntries = entries.filter((entry) => !isFleetEntry(entry));
    if (userEntries.length > 0 || entries.length === 0) kept[eventName] = userEntries;
  }
  return kept;
}

function hooksOf(settings: ClaudeSettings): Record<string, unknown> {
  return isRecord(settings.hooks) ? settings.hooks : {};
}

function getHookBinaryName(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
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
  hooks: Array<{ type: string; command: string; timeout?: number }>;
};

type ClaudeSettings = Record<string, unknown>;

function buildHookEntries(command: string): Record<string, HookEntry[]> {
  const simpleHook = (timeout?: number): HookEntry => ({
    hooks: [{ type: 'command', command, ...(timeout != null ? { timeout } : {}) }]
  });

  const matcherHook = (matcher: string, timeout?: number): HookEntry => ({
    matcher,
    hooks: [{ type: 'command', command, ...(timeout != null ? { timeout } : {}) }]
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
    PreCompact: [matcherHook('auto'), matcherHook('manual')]
  };
}

export function getHookBinarySourcePath(): string {
  // Dev: hooks/bin/<binary>
  const devPath = join(process.cwd(), 'hooks', 'bin', HOOK_BINARY_NAME);
  if (existsSync(devPath)) return devPath;

  // Production: resources/hooks/<binary>
  const resourcesPath = join(process.resourcesPath, 'hooks', HOOK_BINARY_NAME);
  if (existsSync(resourcesPath)) return resourcesPath;

  return devPath; // fallback
}

function removeLegacyScript(hooksDir: string): void {
  const legacyDest = join(hooksDir, LEGACY_SCRIPT_NAME);
  if (!existsSync(legacyDest)) return;
  try {
    unlinkSync(legacyDest);
    log.info('removed legacy Python hook script');
  } catch {
    log.warn('failed to remove legacy hook script');
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

  try {
    const sessionStart = hooksOf(readSettings(settingsPath)).SessionStart;
    return Array.isArray(sessionStart) && sessionStart.some(isFleetEntry);
  } catch {
    return false;
  }
}

/**
 * Install Fleet's hook binary and entries into a Claude config folder.
 *
 * Settings are validated before anything is touched: an unreadable file throws
 * `UnreadableSettingsError` and leaves both the file and the hooks folder as
 * they were. Fleet's existing entries - including legacy Python ones and older
 * unquoted commands - are replaced rather than kept, so a re-install always
 * leaves exactly the current set.
 */
export function install(configDir?: string): void {
  log.info('installing hooks');
  const { hooksDir, settingsPath, hookDest } = resolvePaths(configDir);

  const settings = readSettings(settingsPath);

  const source = getHookBinarySourcePath();
  if (!existsSync(source)) {
    log.error('hook binary source not found', { source });
    throw new Error(`Hook binary not found: ${source}`);
  }

  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
  removeLegacyScript(hooksDir);
  try {
    copyFileSync(source, hookDest);
    chmodSync(hookDest, 0o755);
    log.info('hook binary installed', { dest: hookDest });
  } catch (err) {
    log.error('failed to copy/chmod hook binary', { error: String(err) });
    throw new Error(`Failed to install hook binary: ${String(err)}`);
  }

  const hooks = withoutFleetHooks(hooksOf(settings));
  const newEntries = buildHookEntries(quoteHookCommand(hookDest, process.platform));
  for (const [eventName, entries] of Object.entries(newEntries)) {
    const existing = hooks[eventName];
    hooks[eventName] = Array.isArray(existing) ? [...(existing as unknown[]), ...entries] : entries;
  }

  const next = { ...settings, hooks };
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  try {
    writeSettings(settingsPath, next);
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
  removeLegacyScript(hooksDir);

  if (!existsSync(settingsPath)) return;

  try {
    const settings = readSettings(settingsPath);
    if (!isRecord(settings.hooks)) return;
    const hooks = withoutFleetHooks(settings.hooks);
    const next: ClaudeSettings = { ...settings, hooks };
    if (Object.keys(hooks).length === 0) delete next.hooks;
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    writeSettings(settingsPath, next);
    log.info('settings.json cleaned');
  } catch (err) {
    log.warn('failed to clean settings.json', { error: String(err) });
  }
}
