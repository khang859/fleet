import { stringify } from 'smol-toml';
import type { HookEntry } from '../../claude-sessions/hook-installer';

/** Commands crew never run in auto or bypass mode: Fleet pushes and opens pull requests itself. */
const CREW_DENY = ['git push*', 'gh pr create*', 'gh pr merge*', 'gh pr review*'];

/**
 * What the auto-mode classifier never lets crew do, on top of Claude Code's
 * own rules (`$defaults`). It judges each call, so it also catches what no
 * command pattern can, such as a write outside the worktree.
 */
const CREW_HARD_DENY = [
  '$defaults',
  'Fleet crew boundary: never push any git branch or tag, and never open, approve, merge or close a pull request. Fleet does these itself after the step.',
  "Fleet crew boundary: never create, write, change or delete any file outside the session's working directory and its --add-dir folders, by any tool or shell command.",
  'Fleet crew boundary: never deploy to production, and never change cloud resources, DNS, secrets or IAM.'
];

/**
 * The `--settings` file a Claude crew member starts with. Claude Code merges
 * it over the user's own settings, so everything else, permission rules
 * included, stays the user's.
 *
 * - AskUserQuestion is denied: a crew member asks through its brief's
 *   channel, and a question dialog in a pane nobody watches would hold it.
 * - Bypass mode is locked off. The strictest value of a lock wins over every
 *   other file, so no setting of the user's can turn it back on for crew.
 * - The editor is the normal one: text Fleet types into a vim NORMAL-mode
 *   prompt would run as vim commands.
 * - `hooks` are Fleet's entries as the global install writes them.
 * - The status line runs Fleet's hook binary, given its command: it shows the
 *   member's name and passes the session's cost and subscription usage to
 *   Fleet, which no hook event carries.
 * - In auto mode, pushes and pull requests are denied, which holds in every
 *   mode, and `autoMode.hard_deny` gives the classifier Fleet's boundaries.
 */
export function claudeJobSettings(
  hooks: Record<string, HookEntry[]>,
  opts: { hookCommand?: string; auto?: boolean } = {}
): Record<string, unknown> {
  const { hookCommand, auto = false } = opts;
  return {
    permissions: {
      deny: ['AskUserQuestion', ...(auto ? CREW_DENY.map((rule) => `Bash(${rule})`) : [])],
      disableBypassPermissionsMode: 'disable'
    },
    editorMode: 'normal',
    hooks,
    ...(hookCommand === undefined
      ? {}
      : { statusLine: { type: 'command', command: `${hookCommand} statusline`, padding: 0 } }),
    ...(auto ? { autoMode: { hard_deny: CREW_HARD_DENY } } : {})
  };
}

/**
 * The `--permissions` file of an eva crew member in bypass mode. A `deny`
 * rule holds even in bypass mode, and combines with the user's own rules.
 * It has no `allow`, since the file takes the place of the user's.
 */
export function evaJobPermissions(): string {
  return stringify({ permissions: { deny: CREW_DENY.map((rule) => `bash(${rule})`) } });
}
