# Duplicate `npm run dev` instances, and SIGTERM not stopping Fleet

## What happened

Agents started `npm run dev` in the background, lost track of it, and started another.
Dev mode skips the single-instance lock, so the second run opened a second window.
Its Electron could not bind the per-checkout CDP port (`bind() failed: Address already in use`), and vite moved to 5174.
It still overwrote `.fleet-drive/session.json` with its own pid and renderer URL.
`npm run drive` then connected to the first instance's port, looked for the second one's URL, and found no Fleet window.

Stopping it was also broken: `kill <pid>` did nothing the first time.
Electron installs its own SIGTERM/SIGINT/SIGHUP handler, which turns the first signal into an ordinary `app.quit()`.
The `process.on('SIGTERM')` handler in `src/main/index.ts` never runs, even when registered after `whenReady`.
That quit goes through the window `close` handler, and with a live terminal the "Close Fleet?" dialog blocks it.
A second SIGTERM hard-kills without cleanup.

## Fix

- `scripts/drive/dev-guard.ts` runs first in `predev`.
  It probes this checkout's CDP port and exits with the running pid if Fleet dev is already up.
  It probes the port, not the session file, because the file outlives a crash and does not exist yet while an instance is starting.
- `npm run drive -- stop` sends SIGTERM.
  If the quit dialog holds the app, it crashes the renderer over CDP (`Page.crash`).
  `QuitGuard` treats a renderer that is gone as "close anyway", so the quit finishes through `will-quit` and `shutdownAll` still runs.

## Lesson

In Electron's main process, do not rely on Node signal handlers for SIGTERM/SIGINT/SIGHUP.
Handle shutdown through `before-quit`/`will-quit`.
