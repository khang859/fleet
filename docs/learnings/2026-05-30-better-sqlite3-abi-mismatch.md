# better-sqlite3: the Node vs Electron ABI catch-22, and the bootstrap abort it causes

Merged from two write-ups of the same trap.
First hit during the Kanban board smoke test (that subsystem is gone); the module is now loaded by `src/main/learnings/learnings-store.ts` and `vec-extension.ts`, so the trap is still live.

## Symptom

The renderer reports missing IPC channels that plainly exist in source:

```
Error invoking remote method 'x:y': Error: No handler registered for 'x:y'
```

Pre-existing channels go missing too, which makes it look like the whole `registerXIpc` call stopped running.
The app does not crash.
The window opens, panes render, terminals work.
Only the features whose registration sits after the throwing line are dead, and they fail as *empty* rather than as errors - a saved API key field looks unset, a session list shows nothing, a catalog falls back to cache.
So the app feels about 80% alive.

## Root cause

`better-sqlite3` is a native module, so its compiled `.node` binary is tied to one **NODE_MODULE_VERSION (ABI)**, and the two runtimes differ:

- System Node - used by vitest and `npm test`
- Electron - used by `npm run dev` and the packaged app

`npm rebuild better-sqlite3` builds for the **Node** ABI and overwrites the Electron build.
`electron-builder install-app-deps` does the reverse.
Each rebuild is destructive to the other.

When the store constructor throws on a load failure inside the `app.whenReady().then(async () => { ... })` bootstrap in `src/main/index.ts`, **the whole async block aborts**.
It is called with a bare `void` and no `.catch`, so nothing surfaces the throw.
Every IPC registration after that line silently never happens.

## Diagnosis

```bash
# What ABI does each runtime want?
node -e "console.log(process.versions.modules)"
ELECTRON_RUN_AS_NODE=1 npx electron -e "console.log(process.versions.modules)"

# The definitive test - does the binary load under Electron?
ELECTRON_RUN_AS_NODE=1 npx electron -e \
  "try{require('better-sqlite3')(':memory:').close();console.log('OK')}catch(e){console.log('FAILS',e.message.split('\n')[0])}"
```

`node -e "require('better-sqlite3')"` succeeding proves nothing - it only tests the Node ABI.

`npm run dev > file 2>&1` captures none of the startup log; the output is swallowed when stdout is not a tty.
Use `script -q file npm run dev` to get a pty and see the real error.

## Fix

The npm hooks are self-healing, so normally you do nothing:

| Command | ABI | Hook |
| --- | --- | --- |
| `npm test` | Node | `pretest` runs `rebuild:node` |
| `npm run dev` | Electron | `predev` runs `rebuild:electron` |

`rebuild:electron` chains a forced pass after `install-app-deps`, because `install-app-deps` trusts a marker rather than the actual ABI and can report "finished" over a stale binary:

```
"rebuild:electron": "electron-builder install-app-deps && electron-rebuild -f -w better-sqlite3"
```

The forced pass costs ~2s (it installs a prebuilt binary rather than compiling), so `predev` pays it every time and `npm run dev` can no longer start against a Node-ABI binary.

**The one remaining bypass:** `npx vitest run` skips the `pretest` hook.
Straight after `npm run dev`, a bare `npx vitest run` fails hundreds of tests with `NODE_MODULE_VERSION`.
Use `npm test`, then `npm run rebuild:electron` to put the app back.
This is expected, not a regression.

If a rebuild "succeeds" and the app still throws, force it from source:

```bash
./node_modules/.bin/electron-rebuild -f -b -w better-sqlite3 --build-from-source
```

Then verify it loads under Electron with the command above, and fully restart the dev server.

## Takeaways

1. **Diagnose `No handler registered` as a bootstrap abort, not a missing handler.** If the handler exists in source and is registered in `whenReady`, something earlier in that async block threw. The startup log has the real error; the presence or absence of each subsystem's own "opened" / "registered" log line brackets where the abort happened.
2. **Native modules verified by `npm test` are not verified for Electron.** Tests pass under Node; that says nothing about the Electron ABI. The only check is launching the app.
3. **Bootstrap ordering is a latent footgun.** Registering IPC handlers as the last line after several throwable `await`s means one unrelated failure strips a whole feature's IPC. Register handlers early, or wrap risky bootstrap steps so one failure does not take down unrelated wiring.

## Related

- `docs/learnings/2026-08-05-the-dev-app-runs-stale-main-code.md` - the neighbouring trap that this one masks. Both present as `No handler registered`, and an ABI failure also leaves an Electron orphan holding the debug port.
