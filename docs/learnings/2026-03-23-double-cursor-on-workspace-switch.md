# Double Cursor After Workspace Switch

## What happened

When running a TUI like Claude Code inside Fleet, switching macOS workspaces (Mission Control) and returning showed **two cursors** simultaneously:
1. The TUI-drawn cursor glyph (rendered by Claude Code into the terminal buffer)
2. xterm.js's hardware cursor (which should be suppressed in TUI/alt-screen mode)

## Root cause

Fleet's cursor suppressor (`createTerminal` in `use-terminal.ts`) intercepts `\x1b[?25h` (DECTCEM show-cursor) from PTY data via `term.parser.registerCsiHandler`. This works for suppressing cursor show sequences that come through the **PTY data stream**.

However, when the Electron window regains focus after a workspace switch, **xterm.js internally re-enables its hardware cursor** as part of its focus-restore logic. This internal path completely bypasses the CSI parser handler — xterm never writes `\x1b[?25h` through the parser; it directly tells its renderer to show the cursor.

## Fix

Added a `window` `focus` event listener in `createTerminal`. When the window regains focus while `tuiMode` is active (alt-screen or `cursorHidden: true`), we write `\x1b[?25l` to re-hide xterm's hardware cursor. The listener is cleaned up in `cursorSuppressor.dispose()`.

```javascript
const onWindowFocus = (): void => {
  if (tuiMode && term.element) {
    term.write('\x1b[?25l');
  }
};
window.addEventListener('focus', onWindowFocus);
```

## Key lesson

`term.parser.registerCsiHandler` only intercepts sequences from **external data** (PTY output written through `term.write()`). xterm.js internal state changes (focus/blur handling, renderer repaints) bypass the parser entirely. For behaviors that must persist across window focus events, use `window.addEventListener('focus', ...)`.
