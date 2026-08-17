# Pane cwd was never written back to the layout

## Symptom

A tab kept coming back in the folder it was first opened in.
The user `cd`'d a pane from `~/.claude/output-styles` to `~/Development/fleet`, and the pane title and the sidebar entry went on saying `output-styles` after the next restart.
It looked like the title was stuck, so the first instinct was to hunt for a stale title.

## What was actually wrong

The title was not stuck at all.
`PaneHeader` renders `shortenPath(liveCwd)` and `TabItem` renders `cwdBasename(liveCwd ?? tab.cwd)`, so both follow the live cwd as soon as it changes.
Driving the dev app confirmed it: after a `cd`, both updated within one poll interval.

The real gap was one layer down.
`useCwdStore` held the live cwd for the session only.
Nothing ever wrote it back into the pane leaf's `cwd` or the tab's `cwd`, and those are what `LayoutStore` persists and what the next launch spawns the PTY into.
So every restart replayed the original folder, and the pane was genuinely in `output-styles` again - correctly labelled, wrong place.

## Fix

Added `updatePaneCwd(paneId, cwd)` to the workspace store and called it from `initCwdListener` alongside `setCwd`.
It updates the leaf always, and the tab's own `cwd` only when the pane is the tab's first pane, since that is the one the tab tracks.

Two details that matter:

- The cwd poller fires every 5 s regardless of movement, so the action bails out when nothing changed.
  Without that guard it would mark the layout dirty forever and rewrite it to disk on a timer.
- `let changed = false` mutated inside a `.map` callback trips `@typescript-eslint/no-unnecessary-condition`, because TS narrows the flag to the literal `false` and does not widen it for the closure.
  Comparing the mapped array against the original (`tabs.every((tab, i) => tab === state.workspace.tabs[i])`) is what the rest of this file already does.

## Lessons

- "The label is wrong" and "the state behind the label is wrong" look identical in a screenshot.
  Ask which one it is before reading title code.
  The cheap discriminator here was the reset (↺) icon in the pane title pill: it only renders when `labelIsCustom` is true, so its absence proved the title was following the cwd, not pinned.
- Reproducing in the dev app with `npm run drive` settled in two commands what grepping could not.
  `window.fleet.pty.input({paneId, data: "cd /tmp\r"})` via `drive eval` is the way to send keystrokes to a terminal pane - `drive keys` only reaches renderer DOM handlers.
- On macOS there is no OSC 7 source at all.
  `~/.fleetrc.sh` is referenced in a comment in `ipc-handlers.ts` but nothing creates it, and the user's zsh has no iTerm2 or p10k integration, so `TERM_PROGRAM` is empty.
  Every cwd update on macOS comes from `CwdPoller`'s 5 s `pid-cwd` poll.
- Live session state and persisted layout state are two different stores here.
  Anything that should survive a restart has to be written to the workspace store, not only to the session store that the components read.
