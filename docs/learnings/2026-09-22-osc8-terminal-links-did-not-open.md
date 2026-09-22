# OSC 8 terminal links showed a confirm popup, then did nothing

## What happened

Clicking a link that Claude Code printed in a terminal pane (for example a GitHub PR link) showed a "Do you want to navigate to ...?" popup.
Clicking OK did nothing.

## Why

Claude Code, `gh` and `ls --hyperlink` print OSC 8 hyperlinks: the link target is hidden in an escape sequence, not in the visible text.
xterm.js handles those through `ITerminalOptions.linkHandler`, not through `WebLinksAddon`.
We never set `linkHandler`, so xterm used its built-in `defaultActivate` (`OscLinkProvider.ts`).
That calls `confirm()`, then `window.open()` with no URL, then sets `location.href` on the new window.
The main window's `setWindowOpenHandler` gets `about:blank`, `safeOpenExternal` rejects it, and the open is denied, so the link goes nowhere.

## Fix

`createTerminal` in `src/renderer/src/hooks/use-terminal.ts` now passes `linkHandler: { activate }` to the `Terminal`.
It shares one handler with `WebLinksAddon`: Cmd+click (Ctrl+click off macOS) calls `window.fleet.shell.openExternal`, a plain click is ignored.

## Takeaway

Any xterm feature with a browser-default fallback (`confirm`, `window.open`) breaks in Electron once `setWindowOpenHandler` denies windows.
Give xterm an explicit handler instead of relying on its default.
