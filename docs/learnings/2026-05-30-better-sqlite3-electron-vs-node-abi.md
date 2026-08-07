# better-sqlite3: Electron vs Node ABI catch-22 (and the kanban bootstrap abort it caused)

Hit during the first real GUI smoke test of the Kanban board (Phase 2) inside WSL.

## Symptom

- Board opened but was always empty.
- Clicking **Create** on a new task did nothing; the form stayed open.
- Main-process log: `Error occurred in handler for 'kanban:create-task': Error: No handler registered for 'kanban:create-task'`.

## Root cause

`src/main/kanban/kanban-store.ts` is the **only** consumer of `better-sqlite3` (a native module) in the app. `better-sqlite3` must be compiled against the ABI of whatever runtime loads it, and **Electron and Node have different `NODE_MODULE_VERSION` ABIs**.

The trap:
- Running the **test suite** requires the binary built for **Node** (the project note says run `npm rebuild better-sqlite3` before vitest, since vitest runs under Node).
- Running **`npm run dev`** loads the binary under **Electron**, which needs the Electron ABI (originally produced by `postinstall` → `electron-builder install-app-deps`).
- `npm rebuild better-sqlite3` **overwrites** the Electron build with a Node build. After running tests, the next `npm run dev` fails to load `better-sqlite3`.

When `new KanbanStore(...)` (in the `app.whenReady().then(async () => { ... })` bootstrap in `src/main/index.ts`) throws on the ABI mismatch, the **entire async bootstrap aborts before `registerKanbanIpc(...)` runs** (it's the last statement). So NO kanban IPC handlers get registered — hence `No handler registered` and the empty board. Any future code that registers IPC handlers *after* a throwable line in that same `whenReady` block has the same fragility.

## Fix

Rebuild `better-sqlite3` against Electron's ABI, then restart `npm run dev`:

```bash
npx electron-rebuild -f -w better-sqlite3
# or: node_modules/.bin/electron-builder install-app-deps
```

## Takeaways

1. **Diagnose `No handler registered` as a bootstrap abort, not a missing handler.** If a handler exists in source and is called in `whenReady`, but is reported missing at runtime, something earlier in that async block threw. Check the startup logs for the real error (here: the native module load). Look for `kanban store opened` (kanban-store.ts) and `kanban IPC handlers registered` (kanban-ipc.ts) — their presence/absence brackets where the abort happened.
2. **Native modules verified by `npm test` are NOT verified for the Electron runtime.** Tests pass under Node; that says nothing about the Electron ABI. The only check is launching the app.
3. **The Node↔Electron rebuild is destructive both ways.** Rebuilding for one breaks the other. **Fixed** with self-healing npm hooks in `package.json`:
   - `rebuild:node` → `npm rebuild better-sqlite3` and `rebuild:electron` → `electron-builder install-app-deps`
   - `pretest` / `pretest:watch` run `rebuild:node` automatically before vitest (Node ABI)
   - `predev` runs `rebuild:electron` automatically before the app (Electron ABI; `install-app-deps` skips already-correct modules, so it's cheap when nothing is stale)

   So `npm test` and `npm run dev` each rebuild for their own ABI on the way in — no manual `electron-rebuild` step, no clobbering.
4. **Bootstrap ordering is a latent footgun.** Registering IPC handlers as the last line after several `await`/throwable calls means any earlier failure silently strips the whole feature's IPC. Consider registering handlers early / wrapping risky bootstrap steps so one failure doesn't take down unrelated wiring.
5. **(2026-06-09) The self-healing hooks have two bypasses.** `npx vitest run` skips the `pretest` hook (only `npm test` triggers it), and `electron-builder install-app-deps` can report "finished" while leaving a stale Node-ABI binary in place (its staleness check trusts a marker, not the actual ABI). When `npm run dev` still hits `NODE_MODULE_VERSION` after a rebuild "succeeded", force it: `./node_modules/.bin/electron-rebuild --force --module-dir . --which-module better-sqlite3`.
6. **(2026-08-06) Bypass #5 is now closed.** `rebuild:electron` chains the forced rebuild after `install-app-deps`:

   ```
   "rebuild:electron": "electron-builder install-app-deps && electron-rebuild -f -w better-sqlite3"
   ```

   The forced pass costs ~2s because it installs a prebuilt binary rather than compiling, so `predev` pays it every time and `npm run dev` can no longer start against a Node-ABI binary. `npx vitest run` still bypasses `pretest`, so that half of the trap remains: after a bare `npx vitest run`, the next `npm run dev` heals itself, but a bare `npx vitest run` on an Electron-ABI binary still fails with the mirror-image error.

## What it looks like when only *part* of the bootstrap is gone

Worth knowing, because the app does not crash and nothing on screen says "broken":

- The window opens, panes render, terminals work. Only the features whose `registerXIpc(...)` sits after the throwing line are dead, and they fail as *empty* rather than as errors: the OpenRouter key field looks unset when a key is saved, the session list shows nothing, the model catalog falls back to cache.
- The tell is in the main-process output: `No handler registered for 'chat:has-key'` and friends. Everything registered before the throw still answers, which is why the app feels ~80% alive.
- **`npm run dev > file 2>&1` captures none of this** - the output is swallowed when stdout is not a tty. Use `script -q file npm run dev` to get a pty and see the startup log.
- Restarting needs `pkill -9 -f electron-vite` **and** `pkill -9 -f node_modules/electron/dist`. A survivor keeps port 57856, the new instance cannot bind it, and `fleet-drive` then times out on `connectOverCDP` against the corpse.
