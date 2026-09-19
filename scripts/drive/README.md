# fleet-drive

Attach to the live `npm run dev` Fleet window over CDP and drive its UI.
Dev-only (`IS_FLEET_DEV`); never present in packaged builds.

## Usage

From the repo root:

```
npm run drive -- up                             # start this checkout's `npm run dev`, wait for the window
npm run drive -- status                         # attached window and daemon
npm run drive -- screenshot [--selector <sel>] [--out <path>] [--png]
npm run drive -- snapshot [--refs]              # ARIA YAML tree; --refs adds [ref=eN]
npm run drive -- click '<sel>' [--shot]
npm run drive -- type '<sel>' '<text>' [--shot]
npm run drive -- keys 'Meta+K' [--shot]         # renderer shortcuts only
npm run drive -- eval '<js expression>' [--shot]
npm run drive -- fixture [name] [--shot]        # list the seedable UI states, or put the window in one
npm run drive -- cmd [id] [--shot]              # list command-palette commands, or run one
npm run drive -- term [--pane id] [--all]       # text of a terminal pane
npm run drive -- term-send '<text>' [--enter] [--pane id]
npm run drive -- term-key <key...> [--pane id]
npm run drive -- term-wait '<regex>' [--pane id] [--all]
npm run drive -- run [file]                     # many verbs in one call, from a file or stdin
npm run drive -- stop | restart
```

Every verb takes `--timeout <ms>` (default 5000, `term-wait` 30000).

`node scripts/drive/client.mts <verb>` is the same thing without npm, and about 100 ms faster per call.
Use it in loops.

Only one `npm run dev` runs per checkout.
A second one exits at once with the pid of the running one, so it is safe to run `npm run dev` when unsure whether the app is up.
`up` is the better way to start it: it runs detached (logs in `.fleet-drive/dev.log`), so no shell owns it and none can lose track of it.
`restart` proves the app that answers afterwards is a new process, which is what a change to main-process code needs.

## The daemon

The first command starts a background daemon that holds one CDP connection to the window.
Every later command is a small Node client that sends one line over a local socket, so a call costs about 60 ms instead of about 600 ms.

- It exits after 15 minutes idle, and restarts itself when a file in `scripts/drive/` changes, so edits here take effect on the next call.
- It reattaches on its own when the window reloads or the app restarts.
- Requests from parallel callers run one at a time, in order.
- Its log is `.fleet-drive/daemon.log`, and `status` prints its pid.

## Screenshots

Screenshots default to `.fleet-drive/screenshots/<timestamp>.jpg` (gitignored).
JPEG costs about 70 ms, a 2x PNG about 800 ms.
Use `--png` (or an `--out` path ending in `.png`) when a one-pixel difference matters.

`--shot` on an action waits for the DOM to be quiet, then prints a screenshot path after the action's own output.
A flat, one-color capture prints a warning: the window is most likely minimized.

## Many steps at once

`run` executes one verb per line on the same connection and stops at the first failure, naming the line.
Blank lines and `#` comments are skipped, and words are quoted as in a shell.

```
npm run drive -- run <<'EOF'
cmd settings
snapshot --refs
click e14 --shot
EOF
```

## Terminal panes

The `term` verbs type into a pane's PTY and read the xterm buffer back, so a TUI such as Claude Code can be run and checked.
They act on the active pane unless `--pane <id>` names one.

```
npm run drive -- term-send claude --enter
npm run drive -- term-wait '❯' --timeout 45000
npm run drive -- term-send 'say hi' --enter
npm run drive -- term                            # what the pane shows now
npm run drive -- term-key ctrl-c ctrl-c          # quit it
```

Keys: `enter escape tab shift-tab backspace up down left right ctrl-c ctrl-d ctrl-l`.
`term-wait` takes a regular expression and prints the matching line, or the last 15 lines of the pane on timeout.

`up` starts the app without the `CLAUDECODE` and `CLAUDE_*` variables of the agent that ran it.
Otherwise Claude Code in a pane thinks it is a child session of that agent.

## Fixtures

Some UI states are expensive to reach for real.
The "cleared" marker on a tool row only appears once a session has built up tens of thousands of tokens of stale tool output, which is a long agent run and real money spent to look at one word on one row.

A fixture writes that state straight into the store, so the rendering can be checked on its own:

```
npm run drive -- fixture agent-cleared-results
npm run drive -- screenshot --selector main
```

Nothing is persisted - reload the window (`npm run drive -- keys 'Meta+r'`) to clear it.
That makes a fixture safe to run against a real session that happens to be open.

Add one in `fixtures.ts`.
Fixtures are JS source strings, not typed builders, because they are evaluated in the renderer where this directory's imports do not exist.
They should find what they need from `__FLEET__.stores` rather than take arguments, so a fixture cannot be pointed at the wrong pane.

## Selectors

`page.locator()` syntax: `role=button[name="Chat"]`, `text=Settings`, raw CSS,
or `testid=<id>` (maps to `getByTestId`).

A ref from `snapshot --refs` (`e12`) also works, and is the fastest way to name an element.
Refs belong to the last snapshot: a ref whose element is gone fails at once and says to take a new snapshot.

## eval

Runs in the renderer.
In dev, `window.__FLEET__.stores` exposes zustand stores:

```
npm run drive -- eval "__FLEET__.stores.workspace.getState().activeTabId"
```

Theme is React state, not a store - read it from the DOM.

The expression may be async, and what it resolves to is what gets printed.
That is how to check something that only settles after the UI has moved - a drag, an animation, a round of state:

```
npm run drive -- eval "(async () => { el.dispatchEvent(ev); await new Promise(r => setTimeout(r, 300)); return getComputedStyle(el).transform })()"
```

## Notes

- Each checkout uses a stable per-checkout debug port (override: `FLEET_DEBUG_PORT`).
  Parallel dev worktrees do not collide.
- `keys` reaches renderer DOM handlers only (e.g. ⌘K), not native menu
  accelerators or `globalShortcut`.
