# fleet-drive attaches to a stale Electron when an orphan holds the debug port

Date: 2026-08-05

## What happened

While verifying the Agent pane's Sessions tab, every IPC call from `npm run drive` failed with:

```
No handler registered for 'agent:session-list'
```

Even the pre-existing `agent:session-load` was missing, which made it look like `registerAgentIpc` had stopped being called.
It had not.
`drive` was talking to an Electron process from a dev server that had died an hour earlier.

## Why it happened

Two independent traps compounded.

### 1. The debug port is derived, and a dead dev server keeps holding it

`deriveDebugPort` in `src/shared/drive-session.ts` hashes the checkout path to a stable port (57856 for this checkout) so parallel worktrees do not collide.
When a dev server dies, its Electron can survive and get reparented to init (`PPID 1`), still listening on that port.

A new `npm run dev` then requests the same port with `--remote-debugging-port`.
Chromium does not fail when the port is taken - it silently falls back to a random one (58792 here).
But the main process still writes the *derived* port into `.fleet-drive/session.json`, so the file names a port the new window is not listening on.

The result: `session.json` claims pid 75515 and port 57856, but 57856 belongs to a zombie from an hour ago, and `drive` connects to the zombie and reports nothing unusual.

### 2. `pgrep -fl "electron-vite dev"` does not find orphans

The obvious "is a dev server already running?" check only matches the *parent* node process.
An orphaned Electron has no such parent, so the check returns nothing and you start a second instance on top of the first.

## How it was diagnosed

```bash
lsof -nP -iTCP:57856          # who actually holds the derived port
cat .fleet-drive/session.json # what drive thinks the port is
pgrep -fl "MacOS/Electron \." # every Electron main, orphan or not
```

The port owner's PID not matching `session.json`'s `pid` is the tell.

## The fix

Kill every Electron main, not just the dev server parent, then start exactly one:

```bash
pkill -f "electron-vite dev"
pkill -f "node_modules/electron/dist/Electron.app"
# orphans can ignore SIGTERM - check and escalate
pgrep -f "MacOS/Electron \." | xargs -r kill -9
```

Verify before driving: the pid in `.fleet-drive/session.json` must equal the pid `lsof -nP -iTCP:<port>` reports.

## Lesson

Before `npm run drive`, check for a **live window on the derived port**, not for a running dev server.
`pgrep "electron-vite dev"` returning nothing does not mean no Electron is running.

A worthwhile hardening for `scripts/drive/core.ts` would be to compare `session.json`'s `pid` against the process actually listening on the port and refuse to attach on a mismatch, rather than connecting to whatever answers.

## Related

- `docs/learnings/2026-05-30-better-sqlite3-electron-vs-node-abi.md` - hit in the same session, and it masked this one for a while. `npm rebuild better-sqlite3` builds for Node's ABI (141 on Node 25) and breaks Electron (140 on Electron 39). `npm run dev` fixes it automatically via its `predev` -> `rebuild:electron` hook; `electron-builder install-app-deps` may consider the module up to date and skip it, in which case `./node_modules/.bin/electron-rebuild -f -w better-sqlite3` forces it.
- When the ABI is wrong, the failure is silent in a specific way worth recognising: main throws inside `app.whenReady().then(...)`, which is called with a bare `void` and no `.catch`, so every IPC registration after the throw never happens and the only symptom is "No handler registered" for unrelated channels.
