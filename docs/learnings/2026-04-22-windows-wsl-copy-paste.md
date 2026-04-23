# Copy/paste broken on Windows/WSL

## Symptoms

On Windows (including when the pane ran WSL), users could not copy or paste in
the terminal. Ctrl+Shift+V opened the Space Fleet visualizer overlay; Ctrl+V
inserted a literal `^V` character; Ctrl+Shift+C did nothing.

macOS was unaffected — Cmd+C/Cmd+V worked via Electron's default Edit menu
(which only exists on macOS).

## Root causes

Two stacked issues:

1. `Ctrl+Shift+V` was bound to the `visualizer` toggle in
   `src/renderer/src/lib/shortcuts.ts`. The document-level handler in
   `use-pane-navigation.ts` called `e.preventDefault()`, so the key never
   reached xterm.js at all.
2. Even if it had, xterm.js had no paste wiring. `use-terminal.ts` registered
   an `attachCustomKeyEventHandler` only for Shift+Enter; nothing called
   `term.paste()` / `navigator.clipboard.*`, and there was no application
   `Menu` with `role: 'paste'` (Electron doesn't install one on Windows/Linux).

## Fix

- Rebound the visualizer to `Ctrl+Alt+Shift+V` on non-mac platforms so the
  terminal paste shortcut is free.
- Added `Ctrl+Shift+C` (copy selection) and `Ctrl+Shift+V` (paste, with
  `\r\n` → `\n` normalization) to the xterm custom key event handler. Both
  call `stopPropagation` so document-level shortcut handlers don't also fire.
- Added a native right-click context menu via a new `TERMINAL_CONTEXT_MENU`
  IPC. The main process builds an Electron `Menu` (Copy / Paste / Select All
  / Clear) and resolves with the chosen action id, which the renderer
  performs against its xterm instance. `Copy` is disabled when no selection
  exists. `Cut` and `Replace highlighted` are intentionally omitted —
  terminal output isn't an editable text field, so the shell has no way to
  delete-then-insert bytes on the user's behalf.
- Left plain `Ctrl+C` alone so SIGINT still works.

## Guardrails for future shortcut additions

**Do not bind `Ctrl+Shift+C`, `Ctrl+Shift+V`, or `Shift+Insert` to any
document-level shortcut.** They are reserved for terminal copy/paste on
Windows/Linux. Every major terminal (Windows Terminal, VS Code, GNOME
Terminal, Alacritty, Kitty, Wezterm) uses this convention.

Also do not register an Electron application menu with `role: 'copy'` /
`role: 'paste'` bound to `CmdOrCtrl+C`/`CmdOrCtrl+V` on Windows — that would
break the in-terminal SIGINT behavior users depend on. On macOS the default
menu is fine (Cmd is not used for signals in the shell).
