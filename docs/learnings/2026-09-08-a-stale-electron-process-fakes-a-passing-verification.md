# A stale Electron process makes fleet-drive verify the wrong app

**Date:** 2026-09-08
**Area:** `scripts/drive/`, verifying main-process changes

## What happened

Settings > Updates had just been given a release-note history read from a bundled `CHANGELOG.md`.
To check the "the changelog cannot be read" path, the file was moved aside and the app restarted:

```bash
pkill -f "electron-vite dev"
mv CHANGELOG.md /tmp/...
npm run dev
npm run drive -- eval 'window.fleet.updates.getReleaseHistory().then(h => h.length)'
```

It answered `164`, with the file demonstrably gone from disk and no `changelog unreadable` line in the log.
Read at face value that says the reader ignores its own path and invents a history, which is not a thing it can do.

## Why

`pkill -f "electron-vite dev"` matches the vite wrapper, not the Electron app it spawned.
The app process survives, keeps its `remote-debugging-port` open, and keeps the history it parsed *before* the file was moved - `loadReleaseHistory` caches for the life of the process.

`fleet-drive` attaches to whatever owns the port named in `.fleet-drive/session.json`.
That was still the old app, so every `eval`, `click` and `screenshot` was being answered by a process running the pre-change code against the pre-change filesystem.
`ps -eo pid,lstart,cmd` showed two Electron processes: one from 09:46 and one from 09:48.

## Fix

Kill the app, not just the wrapper, and confirm nothing is left before restarting:

```bash
pkill -f "electron/dist/electron \."   # the app
pkill -f "electron-vite dev"           # the wrapper
ps -eo pid,lstart,cmd | grep -E "electron-vite dev|electron/dist/electron \."
```

## How to avoid it

- After any restart meant to pick up a main-process change, check `lstart` on the Electron process before trusting a single drive result. Main is where a stale process hides: renderer edits arrive over HMR, so the window looks current while main is minutes old.
- A drive result that contradicts the filesystem is a signal about which process answered, not about the code. Chase the process before changing the code.
- The verification that cannot be faked this way is the one that reads the log the *current* process is writing - the run that finally failed correctly also had exactly one `changelog unreadable` line in it.
- `npm run drive` can be pointed at a packaged build for a real `app.isPackaged` check: it writes no session file (that needs `ELECTRON_RENDERER_URL`), so launch it with `FLEET_DEV=1`, then edit `.fleet-drive/session.json` to that app's CDP port with `rendererUrl` set to `file://`. Put the file back afterwards.
