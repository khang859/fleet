import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RUNTIME_LABEL,
  RUNTIME_MIN_VERSION,
  type CrewRuntime,
  type RuntimeCheck,
  type RuntimeCheckItem
} from '../../../shared/agency-crew';
import { isRecord } from '../../../shared/is-record';
import { hookBinaryCurrent } from '../../claude-sessions/hook-installer';
import { getDefaultShell } from '../../shell-detection';
import { runCapture, type Captured } from '../exec';
import { versionOf } from '../preflight';

const PROBE_TIMEOUT_MS = 10_000;

/** Where each runtime's binary is found, and the version it reports. */
export type RuntimeCheckDeps = {
  /**
   * Runs a line in the shell a terminal pane gets, in `cwd`, with `env` on
   * top of its environment; null when the shell cannot start.
   */
  shell: (line: string, cwd: string, env?: Record<string, string>) => Promise<Captured>;
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

/** The files that set a value, or none. */
const pathsWhere = (
  files: SettingsFile[],
  test: (data: Record<string, unknown>) => boolean
): string[] => files.filter((f) => test(f.data)).map((f) => f.path);

/** A check that passes with `ok` as its note, or warns or fails with what is wrong. */
function item(
  name: string,
  ok: string,
  wrong: string[],
  state: 'warn' | 'fail' = 'fail'
): RuntimeCheckItem {
  return wrong.length === 0
    ? { name, state: 'ok', note: ok }
    : { name, state, note: wrong.join(' ') };
}

/**
 * What in the user's Claude settings keeps Fleet from following crew, and
 * what crew do differently from the user's own sessions. Bypass mode and vim
 * mode are warnings: the job's settings turn both off, and only managed
 * settings rank above them.
 */
function claudeSettingsChecks(files: SettingsFile[], managed: string | null): RuntimeCheckItem[] {
  const noHooks = pathsWhere(files, (d) => d.disableAllHooks === true);
  const bypass = pathsWhere(files, (d) => defaultMode(d) === 'bypassPermissions');
  const vim = pathsWhere(files, (d) => d.editorMode === 'vim').filter((p) => p === managed);
  return [
    item(
      'Hooks on',
      'Fleet sees when crew start, stop and ask.',
      noHooks.map(
        (path) =>
          `disableAllHooks is on in ${path}, so Fleet cannot follow Claude crew. Turn it off to hire them.`
      )
    ),
    item(
      'No bypass mode',
      'Crew ask before risky actions.',
      bypass.map(
        (path) =>
          `${path} starts Claude Code in bypass mode. Crew start in default mode, with bypass mode locked off.`
      ),
      'warn'
    ),
    item(
      'Vim mode off',
      'Text Fleet types into a crew pane lands as typed.',
      vim.map(
        () =>
          'Managed settings turn on vim mode, so text Fleet types into a crew pane can run as vim commands. Roles can still be hired.'
      ),
      'warn'
    )
  ];
}

/** Found, and new enough. Nothing else is checked of a runtime that is not found. */
function binaryChecks(
  runtime: CrewRuntime,
  path: string | null,
  version: string | null
): RuntimeCheckItem[] {
  const label = RUNTIME_LABEL[runtime];
  const min = RUNTIME_MIN_VERSION[runtime];
  const installed = item(
    'Installed',
    'Found on the PATH a crew pane gets.',
    path === null ? [`${label} is not installed, or not on the PATH a terminal pane gets.`] : []
  );
  if (path === null) return [installed];
  const wrongVersion =
    version === null
      ? `${label} at ${path} did not report a version.`
      : versionAtLeast(version, min)
        ? null
        : `${label} ${version} is older than ${min}, the oldest crew run on.`;
  return [
    installed,
    item('Version', `${min} or newer, as crew need.`, wrongVersion === null ? [] : [wrongVersion])
  ];
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
  const { path, version } = await binary(runtime, cwd, deps);
  const checks = binaryChecks(runtime, path, version);
  if (runtime === 'claude' && path !== null) {
    checks.push(
      item(
        'Fleet hook',
        'The same version as this Fleet.',
        deps.hookCurrent()
          ? []
          : [
              "Fleet's Claude Code hook is missing or out of date. Turn on Track Claude Code sessions in Settings > Workspaces."
            ]
      ),
      ...claudeSettingsChecks(await claudeSettings(cwd, deps), managedSettingsPath(deps.platform))
    );
  }
  return { runtime, path, version, checks };
}

/**
 * Whether Claude Code is signed in, as a crew pane in `cwd` with `env` would
 * run it. Claude Code reads its own login, and the shell passes on only yes
 * or no, so the account's email and plan never reach Fleet.
 */
export async function claudeSignedIn(
  cwd: string,
  env: Record<string, string>,
  shell: RuntimeCheckDeps['shell']
): Promise<boolean | null> {
  const out = await shell(
    `claude auth status --json 2>/dev/null | awk 'match($0, /"loggedIn"[[:space:]]*:[[:space:]]*true/) { print "yes"; exit } /"loggedIn"/ { print "no"; exit }'`,
    cwd,
    env
  );
  const answer = out?.stdout.trim();
  return answer === 'yes' ? true : answer === 'no' ? false : null;
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
    shell: async (line, cwd, env) =>
      runCapture(getDefaultShell(), ['-c', line], { timeoutMs: PROBE_TIMEOUT_MS, cwd, env }),
    readJson: readJsonFile,
    platform: process.platform,
    claudeConfigDir,
    hookCurrent: () => hookBinaryCurrent(claudeConfigDir)
  };
}
