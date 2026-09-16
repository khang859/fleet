## Why

Cmd+click on a path in terminal output works today only when the text carries a separator, so `src/main/index.ts` is clickable but the bare names that `ls`, `ls -l` and `ls -F` print are not.
That is the single most common way a user sees filenames on screen, and it is the one place the feature does nothing.

The current detector refuses bare names on purpose: without a separator there is nothing in the grammar to tell `index.ts` from `Node.js` or `v1.2.3`, and every guess would cost a `stat`.
A directory listing of the pane's own cwd removes that problem.
A bare token is a file exactly when it is one of the names in that listing, which is a set membership test in memory, not a filesystem probe per word.

## What Changes

- A whitespace-delimited token with no separator becomes a path candidate when it exactly matches an entry name in the pane's current working directory.
- The pane reads its cwd listing once through the existing `file:readdir` IPC and caches it with a short TTL, so hovering a screen of `ls` output costs one directory read, not one probe per word.
- Bare-name candidates skip the `stat` round trip entirely.
  Listing membership already proves existence and already reports whether the entry is a directory.
- The `ls -F` classify suffixes `*`, `@`, `=` and `|` are stripped from a token before the membership test, so `build.sh*` matches `build.sh`.
- A trailing `:line` or `:line:col` on a bare name is honoured the same way it already is on a separator path, so `README.md:12` opens at line 12.
- Everything already true of separator paths stays true for bare names: Cmd/Ctrl+click only, plain click still selects, remote (ssh/mosh) panes yield nothing, folders and archives reveal rather than open, and the right-click menu offers Open in Fleet, Reveal and Copy Path.

Non-goals for this change:

- `ls <other-dir>` output.
  Those names belong to a directory that is not the pane's cwd, and pairing a printed name with the argument of a command scrolled off screen is guesswork.
- Names containing spaces, quoted or not.
  Whitespace is still the token boundary, which is an existing limitation of separator paths too.
- The Agent pane.
  Scope is terminal panes, as it was for the original feature.

## Capabilities

### New Capabilities

- `terminal-path-links`: Which text in a terminal pane becomes a clickable file path, and what activating one does.
  This change introduces the capability's spec and the requirements are scoped to bare filename detection; the separator-path behavior that already ships is stated only where the new behavior must agree with it.

### Modified Capabilities

None.
The project has no existing spec for terminal path links.

## Impact

- `src/shared/terminal-path-detect.ts`: the detector accepts an optional set of directory entry names and emits bare-name candidates against it.
- `src/renderer/src/lib/terminal-path-links.ts`: the provider fetches and caches the cwd listing, marks bare-name candidates as pre-verified, and skips their `stat`.
- `src/renderer/src/hooks/use-terminal.ts`: one new dependency wired into the provider, backed by `window.fleet.file.readdir`.
- No new IPC channel, no preload change, no main process change.
- Tests: `src/shared/__tests__/terminal-path-detect.test.ts` and `src/renderer/src/lib/__tests__/terminal-path-links.test.ts`.
