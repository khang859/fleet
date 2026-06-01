# better-sqlite3: Node ABI vs Electron ABI mismatch breaks kanban IPC

## What happened

After running `npm rebuild better-sqlite3` (to fix a vitest run), starting the app
with `npm run dev` flooded the renderer console with:

```
Uncaught (in promise) Error: Error invoking remote method 'kanban:list-board':
  Error: No handler registered for 'kanban:list-board'
... same for kanban:list-boards, kanban:list-artifacts, etc.
```

The kanban UI was completely dead — every `window.fleet.kanban.*` call rejected.

## Root cause

`better-sqlite3` is a native module, so its compiled `.node` binary is tied to a
specific **NODE_MODULE_VERSION (ABI)**. On this machine the two runtimes differ:

- **System Node:** ABI **137** — used by vitest / `npm test`
- **Electron 39.8.2:** ABI **140** — used by `npm run dev` / the app

`npm rebuild better-sqlite3` builds for the **Node** ABI (137). Under Electron that
binary fails to load. In `src/main/index.ts` the bootstrap does
`new KanbanStore(join(KANBAN_HOME, 'kanban.db'), ...)` (~line 754), which opens the
DB via better-sqlite3. When the module can't load, the constructor **throws inside the
async `whenReady` bootstrap**, which aborts the rest of bootstrap — so
`registerKanbanIpc(...)` (called later) never runs. The renderer then hits unregistered
channels → "No handler registered". The failure is silent in the renderer; the real
error is the native-load throw in the **main** process.

## Why it was confusing

- `npm run dev` has a `predev` step (`rebuild:electron` = `electron-builder
  install-app-deps`) that is *supposed* to rebuild natives for Electron — but it ran with
  `buildFromSource=false` and short-circuited on a stale/Node-ABI prebuilt, so it did
  **not** produce a 140 binary.
- `node -e "require('better-sqlite3')"` succeeded (loads under Node 137), which made it
  look fine. The only definitive test is loading under **Electron**, not Node.

## Diagnosis commands

```bash
# What ABI does each runtime want?
node -e "console.log(process.versions.modules)"                 # 137 (system node)
ELECTRON_RUN_AS_NODE=1 npx electron -e "console.log(process.versions.modules)"  # 140

# Definitive test — does the binary load under Electron?
ELECTRON_RUN_AS_NODE=1 npx electron -e \
  "try{require('better-sqlite3')(':memory:').close();console.log('OK')}catch(e){console.log('FAILS',e.message.split('\n')[0])}"
```

## Fix

The two rebuilds are **not interchangeable** — re-run the one matching your runtime:

| Command | ABI | Use for |
| --- | --- | --- |
| `npm run rebuild:node` (`npm rebuild better-sqlite3`) | Node 137 | vitest / `npm test` |
| `npm run rebuild:electron` (`electron-builder install-app-deps`) | Electron 140 | `npm run dev` / the app |

When `rebuild:electron` short-circuits and the app still throws native-load /
"No handler registered" errors, **force a from-source rebuild**:

```bash
npx electron-rebuild -f -b -w better-sqlite3 --build-from-source
```

Then verify it loads under Electron with the command above, and fully restart
`npm run dev`.

## Takeaway

Bouncing between `npm test` (Node ABI) and `npm run dev` (Electron ABI) leaves
better-sqlite3 built for the wrong runtime. "No handler registered for kanban:*" in the
renderer almost always means the **main-process kanban bootstrap threw on a native-module
load** — rebuild better-sqlite3 for the correct ABI rather than chasing the IPC layer.
