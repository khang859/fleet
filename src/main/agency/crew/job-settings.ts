import type { HookEntry } from '../../claude-sessions/hook-installer';

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
 */
export function claudeJobSettings(
  hooks: Record<string, HookEntry[]>,
  hookCommand?: string
): Record<string, unknown> {
  return {
    permissions: {
      deny: ['AskUserQuestion'],
      disableBypassPermissionsMode: 'disable'
    },
    editorMode: 'normal',
    hooks,
    ...(hookCommand === undefined
      ? {}
      : { statusLine: { type: 'command', command: `${hookCommand} statusline`, padding: 0 } })
  };
}
