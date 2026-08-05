# Learnings: main/preload changes need a dev restart, and a killed dev server leaves the app behind (2026-08-05)

## Symptom

A new IPC channel (`agent:session-append`) did nothing end to end.
The renderer called `window.fleet.agent.appendSession(...)`, the call did not throw, and no file was ever written.
`registerAgentIpc` was wired, the handler existed, the unit tests passed, and main logged nothing at all - not even the `catch` that logs failed writes.

## Root cause

Two things compounding.

1. `npm run dev` is `electron-vite dev` with **no `--watch`**.
   Vite HMR covers the renderer only; `out/main/index.mjs` and `out/preload/index.js` are built once, at startup.
   Any change under `src/main/` or `src/preload/` is invisible until the dev server is restarted - `stat -f '%Sm' out/main/index.mjs` shows the startup time, and `grep <newSymbol> out/preload/index.js` is the quick check.

2. Killing the dev server (`kill <electron-vite pid>`) does **not** kill the Electron app it spawned.
   The orphaned app keeps running against the dead server. Starting a fresh `npm run dev` then leaves two windows alive, and the old one is the more confusing of the pair: its renderer reconnects to the new Vite on 5173 and reloads, which re-reads the **new** preload from disk, while its **old** main process still has no handler for the channel that preload now exposes.
   So `typeof window.fleet.agent.appendSession === 'function'` was true and the send went into a process that had never registered the receiver.

The CDP port makes this worse: `deriveDebugPort` is deterministic per checkout (57856 here), so the second app cannot bind it and falls back to a random port, while `.fleet-drive/session.json` still advertises 57856. fleet-drive therefore attaches to the *stale* app - every `eval`, every `click` and every turn I sent went to the wrong window.

## Fix

When a change touches `src/main/` or `src/preload/`, restart the dev server, and make sure only one app survives:

```bash
pgrep -fl "electron-vite dev"                          # the server
pgrep -fl "Electron.app/Contents/MacOS/Electron"       # the app(s) - expect exactly one
kill <server-pid> && kill <app-pid>                    # the app does not go with the server
rm -f .fleet-drive/session.json
npm run dev
```

Then confirm the bundle actually has the change before debugging anything else:

```bash
grep -c <newSymbol> out/preload/index.js out/main/index.mjs
lsof -iTCP:57856 -sTCP:LISTEN -P -n                    # the app drive will attach to
```

## Also

`npx vitest run` straight after `npm run dev` fails ~450 tests with a `NODE_MODULE_VERSION` mismatch: `predev` rebuilds `better-sqlite3` for Electron's ABI and `pretest` rebuilds it for Node's.
Use `npm test` (which runs `pretest`), and `npm run rebuild:electron` afterwards to put the app back.
This is expected, not a regression - see `docs/learnings/better-sqlite3-node-vs-electron-abi.md`.
