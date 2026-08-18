# Terminal paste silently did nothing on Linux/Windows

## Symptom

On Linux, `Ctrl+Shift+V` in a terminal pane did nothing, and right-click -> Paste from the terminal context menu did nothing.
No error surfaced anywhere: the menu opened, the item clicked, and the shell prompt stayed empty.
Copy worked.
Pasting inside a Claude Code TUI in the same pane worked, which made it look like a Fleet problem only at the plain shell prompt.

## Cause

`src/main/index.ts` installs a deny-by-default permission handler:

```ts
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);
electronSession.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
  callback(ALLOWED_PERMISSIONS.has(permission) && webContents === mainWindow?.webContents);
});
```

`clipboard-read` is not in the allowlist, so every `navigator.clipboard.readText()` in the renderer rejected with `NotAllowedError: Read permission denied`.
Both terminal paste paths wrapped that call in `void ... .then(...)`, so the rejection was swallowed and the failure was completely silent.

This never showed up on macOS because macOS paste goes through Electron's native Edit menu `paste` role, which never touches the async clipboard API.
The `navigator.clipboard.readText()` path is Linux/Windows only, which is why it read as "broken on this machine".

The Claude Code TUI was unaffected because it receives the raw keystroke over the PTY and reads the clipboard from its own process.

## Fix

Read the clipboard in the main process and hand it to the renderer over IPC (`clipboard:read-text`), instead of widening the permission allowlist.
Electron's `clipboard.readText()` in main has no permission gate and no transient-user-activation requirement.

The activation part matters for the context menu specifically: clicking an item in a native `Menu.popup()` is not a DOM user gesture, so even with `clipboard-read` granted that path would have stayed fragile.

## Rules

- In this app, renderer code must not call `navigator.clipboard.readText()`.
  Use `window.fleet.clipboard.readText()`.
  Writing is fine - `clipboard-sanitized-write` is allowlisted.
- A `void promise.then(...)` with no `.catch` turns a denied permission into silence.
  When a feature "does nothing", check for a swallowed rejection before checking the event wiring.
- Reproduce clipboard bugs against the dev build with `npm run drive -- eval`, not by reading the handler code.
  The handler was correct; the API underneath it was denied.

## Gotcha while reproducing

`npm run dev` does not replace an already-running dev instance, and `fleet-drive` attaches to whichever one holds the CDP port - which is the *old* one.
A preload or main change can look like it did not take effect when really the driver is talking to a stale process.
Check `ps -eo pid,lstart,args | grep "electron/dist/electron \."` and kill leftovers before concluding the change did not land.
