# xterm keeps one custom key handler, so a second one silently replaces the first

Date: 2026-10-07

## What happened

`use-terminal.ts` called `term.attachCustomKeyEventHandler` twice: once to let Ctrl/Cmd+K through to the command palette, and once for Shift+Enter and Ctrl+Shift+C/V.
xterm stores a single handler (`CoreBrowserTerminal.attachCustomKeyEventHandler` just assigns `this._customKeyEventHandler`), so the second call replaced the first.
Nothing threw and no test failed.

The visible effect on Linux and Windows: pressing Ctrl+K in a focused terminal pane did not open the palette, and the key reached the PTY as readline kill-line.
In a Claude Code pane it deleted the prompt from the cursor to the end of the line.
The palette never opened because xterm calls `stopPropagation()` on keys it handles, so the window keydown listener that opens it never saw the event.

## Fix

All intercepted keys now go through one `attachCustomKeyEventHandler` call, with a comment saying why there must only be one.
Found while adding the held-Backspace word delete, which needed a third interception.

## Lesson

When an API is named `attach…` or `set…`, check whether it adds or replaces before calling it a second time.
For xterm, any new key interception goes into the existing handler in `use-terminal.ts`, never into a new call.
