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
