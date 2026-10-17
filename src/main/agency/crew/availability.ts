import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RUNTIME_LABEL,
  RUNTIME_MIN_VERSION,
  type CrewRuntime,
  type RuntimeCheck
} from '../../../shared/agency-crew';
import { isRecord } from '../../../shared/is-record';
import { hookBinaryCurrent } from '../../claude-sessions/hook-installer';
import { getDefaultShell } from '../../shell-detection';
import { runCapture, type Captured } from '../exec';
import { versionOf } from '../preflight';

const PROBE_TIMEOUT_MS = 10_000;

/** Where each runtime's binary is found, and the version it reports. */
export type RuntimeCheckDeps = {
  /** Runs a line in the shell a terminal pane gets, in `cwd`; null when the shell cannot start. */
  shell: (line: string, cwd: string) => Promise<Captured>;
  /** A JSON file's contents, or null when it is missing or not JSON. */
  readJson: (path: string) => Promise<unknown>;
  platform: NodeJS.Platform;
  /** The Claude config folder crew panes get. */
  claudeConfigDir: string;
  /** Whether Fleet's hook binary in that folder is the one this Fleet ships. */
  hookCurrent: () => boolean;
};

/** Each part as a number, so 2.1.100 is newer than 2.1.78. */
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** Read through the shell, so a pane's PATH and a wrapper script are what is checked. */
async function binary(
  runtime: CrewRuntime,
  cwd: string,
  deps: RuntimeCheckDeps
): Promise<{ path: string | null; version: string | null }> {
  const found = await deps.shell(`command -v ${runtime}`, cwd);
  const path = found?.code === 0 ? found.stdout.split('\n')[0].trim() || null : null;
  if (path === null) return { path, version: null };
  const out = await deps.shell(`${runtime} --version`, cwd);
  return { path, version: out?.code === 0 ? versionOf(out.stdout) : null };
}

function managedSettingsPath(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'linux') return '/etc/claude-code/managed-settings.json';
  return null;
}

type SettingsFile = { path: string; data: Record<string, unknown> };

/** The Claude settings files a session in `cwd` reads, besides the job's own, that exist. */
async function claudeSettings(cwd: string, deps: RuntimeCheckDeps): Promise<SettingsFile[]> {
  const managed = managedSettingsPath(deps.platform);
  const paths = [
    ...(managed === null ? [] : [managed]),
    join(deps.claudeConfigDir, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json')
  ];
  const files = await Promise.all(
    paths.map(async (path) => ({ path, data: await deps.readJson(path) }))
  );
  return files.filter((f): f is SettingsFile => isRecord(f.data));
}

const defaultMode = (data: Record<string, unknown>): unknown =>
  isRecord(data.permissions) ? data.permissions.defaultMode : undefined;

/**
 * What in the user's Claude settings keeps Fleet from following crew, and
 * what crew do differently from the user's own sessions. Bypass mode and vim
 * mode are warnings: the job's settings turn both off, and only managed
 * settings rank above them.
 */
function claudeSettingsFindings(
  files: SettingsFile[],
  managed: string | null
): Pick<RuntimeCheck, 'problems' | 'warnings'> {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const { path, data } of files) {
    if (data.disableAllHooks === true) {
      problems.push(
        `disableAllHooks is on in ${path}, so Fleet cannot follow Claude crew. Turn it off to hire them.`
      );
    }
    if (defaultMode(data) === 'bypassPermissions') {
      warnings.push(
        `${path} starts Claude Code in bypass mode. Crew start in default mode, with bypass mode locked off.`
      );
    }
    if (path === managed && data.editorMode === 'vim') {
      warnings.push(
        `Managed settings turn on vim mode, so text Fleet types into a crew pane can run as vim commands.`
      );
    }
  }
  return { problems, warnings };
}

/**
 * Whether crew can run on `runtime` in `cwd`, the folder its panes start in.
 * Nothing secret is read: not the Claude login or `~/.claude.json`, and not
 * eva's settings, which hold its key.
 */
export async function checkRuntime(
  runtime: CrewRuntime,
  cwd: string,
  deps: RuntimeCheckDeps
): Promise<RuntimeCheck> {
  const label = RUNTIME_LABEL[runtime];
  const min = RUNTIME_MIN_VERSION[runtime];
  const { path, version } = await binary(runtime, cwd, deps);
  const check: RuntimeCheck = { runtime, path, version, problems: [], warnings: [] };
  if (path === null) {
    check.problems.push(`${label} is not installed, or not on the PATH a terminal pane gets.`);
    return check;
  }
  if (version === null) {
    check.problems.push(`${label} at ${path} did not report a version.`);
  } else if (!versionAtLeast(version, min)) {
    check.problems.push(`${label} ${version} is older than ${min}, the oldest crew run on.`);
  }
  if (runtime === 'claude') {
    if (!deps.hookCurrent()) {
      check.problems.push(
        "Fleet's Claude Code hook is missing or out of date. Turn on Track Claude Code sessions in Settings > Workspaces."
      );
    }
    const found = claudeSettingsFindings(
      await claudeSettings(cwd, deps),
      managedSettingsPath(deps.platform)
    );
    check.problems.push(...found.problems);
    check.warnings.push(...found.warnings);
  }
  return check;
}

/** A JSON file read for the check, or null. Never one that holds a secret. */
async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The check as a terminal pane sees it: the user's shell with the login-shell
 * environment panes get, and the Claude config folder crew panes get.
 */
export function paneRuntimeDeps(claudeConfigDir: string): RuntimeCheckDeps {
  return {
    shell: async (line, cwd) =>
      runCapture(getDefaultShell(), ['-c', line], { timeoutMs: PROBE_TIMEOUT_MS, cwd }),
    readJson: readJsonFile,
    platform: process.platform,
    claudeConfigDir,
    hookCurrent: () => hookBinaryCurrent(claudeConfigDir)
  };
}
