# Double Cursor in TUI Mode

## What happened

When running a TUI like Claude Code inside Fleet, **two cursors** appear simultaneously:

1. The TUI-drawn cursor glyph (rendered by Claude Code into the terminal buffer)
2. xterm.js's hardware cursor (which should be suppressed in TUI/alt-screen mode)

This was first observed after switching macOS workspaces (Mission Control) and returning, and later also when **splitting panes** while Claude Code is running.

## Root cause

Fleet's cursor suppressor (`createTerminal` in `use-terminal.ts`) intercepts `\x1b[?25h` (DECTCEM show-cursor) from PTY data via `term.parser.registerCsiHandler`. This works for suppressing cursor show sequences that come through the **PTY data stream**.

However, **xterm.js internally re-enables its hardware cursor** in several situations, all of which bypass the CSI parser handler entirely — xterm never writes `\x1b[?25h` through the parser; it directly tells its renderer to show the cursor:

1. **Window focus restore** — Electron window regains focus after workspace switch
2. **Terminal element focus** — terminal textarea regains focus after pane split moves focus to a new pane, then user clicks back
3. **Resize reflow** — `fitAddon.fit()` during pane split triggers xterm reflow that re-enables cursor

## Fix

A shared `reSuppressCursor` function writes `\x1b[?25l` whenever `tuiMode` is active, hooked into all three trigger paths:

```javascript
const reSuppressCursor = (): void => {
  if (tuiMode && term.element) {
    term.write('\x1b[?25l');
  }
};
window.addEventListener('focus', reSuppressCursor);        // path 1: window focus
term.textarea?.addEventListener('focus', onTermFocus);      // path 2: terminal focus
const resizeDisposable = term.onResize(() => reSuppressCursor()); // path 3: resize
```

All listeners are cleaned up in `cursorSuppressor.dispose()`.

## Key lesson

`term.parser.registerCsiHandler` only intercepts sequences from **external data** (PTY output written through `term.write()`). xterm.js internal state changes (focus handling, renderer repaints, resize reflows) bypass the parser entirely. For behaviors that must persist, hook into **every code path** that can re-enable the cursor: window focus, terminal element focus, and resize.
