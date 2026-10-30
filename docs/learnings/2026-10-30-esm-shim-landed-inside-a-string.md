# electron-vite's CommonJS shim landed inside a string, so the app wrote no log file

## What happened

The installed app and every dev build wrote no log file.
`~/.fleet/logs` held only old leftovers, and "Report a Problem" had no log text to send.
Logs went only to the console, which nobody sees in an installed app.

## Why

`src/main/logger.ts` called a bare `require` for `electron` and `winston-daily-rotate-file`.
The main bundle is ESM, so that `require` exists only because electron-vite 5 adds a CommonJS shim.

electron-vite 5 finds the place for the shim with a regex: it goes after the last text that looks like a static import.
That regex also matches text inside strings, and two strings in the bundle had an import line:

- the dev CLI entrypoint in `src/main/install-fleet-cli.ts`
- the dev bootstrap HTML in `src/main/secondary-renderer.ts`

The shim landed inside the template string, so `require` did not exist at runtime.
Both calls threw `ReferenceError: require is not defined`.
Two `try/catch` blocks swallowed the error, so the logger fell back to console output with the wrong log level.

Unit tests could not see this, because `require` always exists under Vitest.

A second bug sat behind the first.
`logger.ts` copied `electron.app.getPath` into a variable and called it detached from `app`.
Real Electron throws on that call, and the same `catch` hid it, so a packaged app still thought it was a dev build.
It logged at `debug` with colored console output.
Only a packaged run showed this: the log file existed, but it had `debug` lines.

## Fix

- `logger.ts` uses an explicit `createRequire`, named `nodeRequire` because the shim declares `require` at the top of the bundle.
- `readElectronApp` calls `getPath` on `app`, and a test covers it with a `this`-sensitive fake.
- Neither string reads as a static import any more.
- `scripts/esm-shim-guard.ts` fails the build if a chunk has the shim text but no real shim import.

## Lessons

- A `try/catch` around a load can turn a total failure into silence. Check the output exists, not only that the code runs.
- To verify logging, look for the file on disk from a packaged build.
- electron-vite 6 places the shim with a real parser. After that upgrade the guard and the string workarounds can go.
