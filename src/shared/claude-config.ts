/**
 * Which Claude Code config folder a workspace's *new* terminals are given, and
 * where that answer came from.
 *
 * Two sides read this and must agree. The main process bakes the answer into a
 * pane's environment as `CLAUDE_CONFIG_DIR` at spawn time; Settings describes
 * the same answer back to the user. Settings can only describe the *configured*
 * assignment - a terminal that is already running kept whatever it was spawned
 * with, and an inherited shell environment or Env Sync can put something else
 * in front of it - so nothing here claims to inspect a live process.
 *
 * The folder in question is a Claude Code *user* config folder (the thing
 * `~/.claude` is), not a repository's project-local `.claude` directory.
 */

export type ClaudeConfigSource = 'default' | 'custom';

export type ResolvedClaudeConfig = {
  /** The folder new terminals get. Always a concrete path, never empty. */
  path: string;
  /** `custom` when this workspace overrides the shared default. */
  source: ClaudeConfigSource;
};

const CLAUDE_CONFIG_DIR_NAME = '.claude';

/**
 * Claude Code's own fallback, spelled out.
 *
 * Fleet injects nothing when no folder is configured, which leaves Claude on
 * `~/.claude`. Settings shows that resolved path rather than an empty box,
 * because an empty box asks the user to already know this.
 */
export function defaultClaudeConfigDir(homeDir: string): string {
  const trimmed = homeDir.replace(/[/\\]+$/, '');
  // A Windows home is the only case with no forward slash to copy, so the
  // separator is read off the path itself instead of off `process.platform` -
  // this module is shared and runs in the renderer too.
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return `${trimmed}${separator}${CLAUDE_CONFIG_DIR_NAME}`;
}

/**
 * Resolve one workspace's assignment: its own override, else the Fleet default,
 * else Claude's `~/.claude`. Mirrors the precedence the PTY handler applies.
 */
export function resolveClaudeConfig(args: {
  /** `copilot.claudeConfigDir` - the folder every workspace inherits. */
  defaultDir: string;
  /** `copilot.workspaceOverrides[id]?.claudeConfigDir`, when the workspace has one. */
  overrideDir?: string;
  homeDir: string;
}): ResolvedClaudeConfig {
  const override = args.overrideDir?.trim();
  if (override) return { path: override, source: 'custom' };
  const fallback = args.defaultDir.trim();
  return { path: fallback || defaultClaudeConfigDir(args.homeDir), source: 'default' };
}

/**
 * A workspace name reduced to something safe to put in a folder name.
 *
 * Empty when the name has nothing usable in it (spaces, punctuation only), so
 * callers can tell "no suggestion" from "a suggestion that happens to be short".
 */
export function workspaceSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The folder offered to a new workspace that wants its own: the default folder
 * with the workspace's slug appended.
 *
 * Sitting beside the default folder rather than inside it keeps every Claude
 * config folder in one place and stays hidden, and it cannot be mistaken for a
 * project-local `.claude` directory.
 */
export function suggestClaudeConfigDir(defaultPath: string, name: string): string {
  const slug = workspaceSlug(name);
  if (!slug) return '';
  return `${defaultPath.replace(/[/\\]+$/, '')}-${slug}`;
}

/* ------------------------------------------------------------------------- *
 * Which Claude Code config file the Claude Config settings page is acting on.
 * ------------------------------------------------------------------------- */

/**
 * The three settings files the page can edit, named after the scopes Claude
 * Code's own documentation uses. Managed settings are deliberately absent:
 * they override everything here and are not the user's to edit.
 */
export type ClaudeConfigScope = 'user' | 'project' | 'projectLocal';

/** Settings JSON, or the Markdown memory file that sits beside it. */
export type ClaudeFileKind = 'settings' | 'memory';

/**
 * The directories a scope's path is derived from.
 *
 * Three directories, not one, because Claude Code does not read the two
 * project files from the same place: the shared file comes from the session's
 * working directory, while the local file is placed at the repository root
 * (the main checkout's root, in a worktree). Collapsing them into one "project
 * folder" would point the shared file at a file the session never reads.
 */
export type ClaudeConfigDirs = {
  /** The Claude Code *user* config folder - what `~/.claude` is. */
  configDir: string;
  /** The session's working directory. Absent when no folder has been chosen. */
  sessionDir?: string;
  /** Where `settings.local.json` is placed. Absent when no folder has been chosen. */
  localSettingsRoot?: string;
};

const CLAUDE_MEMORY_FILE = 'CLAUDE.md';
const CLAUDE_SETTINGS_FILE = 'settings.json';
const CLAUDE_LOCAL_SETTINGS_FILE = 'settings.local.json';

/**
 * The separator a path is already written with.
 *
 * Read off the path rather than off `process.platform`, because this module is
 * shared and runs in the renderer too. A Windows path is the only case with no
 * forward slash to copy.
 */
function separatorFor(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

function joinPath(base: string, ...segments: string[]): string {
  const trimmed = base.replace(/[/\\]+$/, '');
  const sep = separatorFor(trimmed);
  return [trimmed, ...segments].join(sep);
}

/**
 * The one file a scope and kind name, or `null` when that combination has no
 * file at all.
 *
 * `projectLocal` + `memory` is the `null` case: Claude Code defines no
 * local-scope memory file, so the page must not offer one.
 *
 * Note that project memory is `<sessionDir>/CLAUDE.md`, at the folder's root -
 * *not* inside its `.claude` directory. Any access check written as "must be
 * under `.claude`" would wrongly reject it, which is why
 * `isAllowedClaudeFilePath` compares against these exact results instead.
 */
export function resolveClaudeFilePath(args: {
  scope: ClaudeConfigScope;
  kind: ClaudeFileKind;
  dirs: ClaudeConfigDirs;
}): string | null {
  const { scope, kind, dirs } = args;

  if (scope === 'user') {
    const dir = dirs.configDir.trim();
    if (!dir) return null;
    return kind === 'settings'
      ? joinPath(dir, CLAUDE_SETTINGS_FILE)
      : joinPath(dir, CLAUDE_MEMORY_FILE);
  }

  if (scope === 'project') {
    const dir = dirs.sessionDir?.trim();
    if (!dir) return null;
    return kind === 'settings'
      ? joinPath(dir, CLAUDE_CONFIG_DIR_NAME, CLAUDE_SETTINGS_FILE)
      : joinPath(dir, CLAUDE_MEMORY_FILE);
  }

  // projectLocal
  if (kind === 'memory') return null;
  const dir = dirs.localSettingsRoot?.trim();
  if (!dir) return null;
  return joinPath(dir, CLAUDE_CONFIG_DIR_NAME, CLAUDE_LOCAL_SETTINGS_FILE);
}

/**
 * Whether a directory is safe to derive a config path from.
 *
 * `isAllowedClaudeFilePath` alone is not enough: it derives the allowlist from
 * the same directories it checks against, so a directory of `/home/me/../../etc`
 * would produce a "matching" path and pass. The directory itself has to be
 * vetted, and it is vetted here rather than in the caller so both processes
 * apply the same rule.
 *
 * Absolute, no traversal segment, no NUL. Deliberately not a normalizer: this
 * module is shared with the renderer and has no access to `node:path`, and a
 * half-correct normalizer is worse than a flat refusal of anything unusual.
 */
export function isSafeClaudeDir(dir: string): boolean {
  if (!dir || dir.includes('\0')) return false;
  const isAbsolute = dir.startsWith('/') || /^[A-Za-z]:[/\\]/.test(dir) || dir.startsWith('\\\\');
  if (!isAbsolute) return false;
  return !dir.split(/[/\\]/).includes('..');
}

/** Every scope/kind pair that names a real file, in the order the page shows them. */
const CLAUDE_FILE_SLOTS: Array<{ scope: ClaudeConfigScope; kind: ClaudeFileKind }> = [
  { scope: 'user', kind: 'settings' },
  { scope: 'user', kind: 'memory' },
  { scope: 'project', kind: 'settings' },
  { scope: 'project', kind: 'memory' },
  { scope: 'projectLocal', kind: 'settings' }
];

/**
 * Every file the Claude Config page may touch, given a set of directories.
 *
 * This is the allowlist the main process checks a write against. It is built
 * from the same resolver the renderer displays, so the two cannot disagree.
 */
export function allowedClaudeFilePaths(dirs: ClaudeConfigDirs): string[] {
  // An unsafe directory contributes nothing, so a traversal attempt yields an
  // empty allowlist and every write against it is refused.
  const safe: ClaudeConfigDirs = {
    configDir: isSafeClaudeDir(dirs.configDir) ? dirs.configDir : '',
    sessionDir: dirs.sessionDir && isSafeClaudeDir(dirs.sessionDir) ? dirs.sessionDir : undefined,
    localSettingsRoot:
      dirs.localSettingsRoot && isSafeClaudeDir(dirs.localSettingsRoot)
        ? dirs.localSettingsRoot
        : undefined
  };
  const paths: string[] = [];
  for (const slot of CLAUDE_FILE_SLOTS) {
    const path = resolveClaudeFilePath({ scope: slot.scope, kind: slot.kind, dirs: safe });
    if (path !== null) paths.push(path);
  }
  return paths;
}

/**
 * Whether a path is one of the five files the page is allowed to touch.
 *
 * Compared as exact strings against freshly derived paths, so a traversal
 * segment or a sibling file inside the same `.claude` directory is refused
 * without needing a normalizer this shared module cannot portably provide.
 * The main process derives the candidate path itself rather than accepting one
 * from the renderer, so a mismatch here means a bug or an attack, not a user
 * with an unusual layout.
 */
export function isAllowedClaudeFilePath(path: string, dirs: ClaudeConfigDirs): boolean {
  return allowedClaudeFilePaths(dirs).includes(path);
}
