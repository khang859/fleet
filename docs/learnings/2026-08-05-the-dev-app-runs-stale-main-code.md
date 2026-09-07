# The dev app runs stale main-process code, and fleet-drive may be driving a different app

Merged from six separate write-ups between 2026-08-05 and 2026-08-08.
They were all the same afternoon-long failure wearing different symptoms, so they now live in one place.

## The shape of the failure

You change something under `src/main/`, `src/preload/`, or in `src/shared/` where main imports it.
You verify through `fleet-drive`.
The app runs, the call returns, nothing errors - and the answer describes code you no longer have on disk.

This is a **false negative**, the worst shape a verification failure can take.
It reads as a pass, so it invites you to go back and "fix" code that was already correct.

There are two independent causes, and they compound.

## Cause 1: main is not rebuilt or restarted on a source change

`npm run dev` is `electron-vite dev` with **no `--watch`**.
Vite HMR covers the renderer only.
`out/main/index.mjs` and `out/preload/index.js` are built once, at startup.

Confirmed by appending a comment to a main-process file and watching the log: `builds 1 -> 1; startups 1 -> 1`.
Neither `electron main process built successfully` nor the app's `startup marker` line appears again.
`touch` does not wake the watcher either.

The renderer hot-reloads normally, which is what makes this so easy to miss.
UI edits appear instantly, so the dev server *looks* live.

Worse, the two halves can go stale independently.
One session had a fresh `settings-store.ts` in `out/` alongside a stale `agent-types.ts`, so a merge over `DEFAULT_SETTINGS.ai.agent.advisor` ran and merged nothing, and the renderer crashed on a field that had a default.
When the app disagrees with a unit test about the value of a constant, stop debugging the code.
One of them is not reading the file you edited, and it is never the test.

## Cause 2: fleet-drive attaches to an orphaned Electron

`deriveDebugPort` in `src/shared/drive-session.ts` hashes the checkout path to a stable port (57856 for this checkout) so parallel worktrees do not collide.

Killing the dev server does **not** kill the Electron app it spawned.
The orphan is reparented to init and keeps listening on that port.
A new `npm run dev` requests the same port; Chromium does not fail when the port is taken, it silently falls back to a random one.
But main still writes the *derived* port into `.fleet-drive/session.json`.

So `session.json` names a pid and a port that belong to two different processes, and `drive` attaches to the corpse.
Every `eval`, every `click`, every turn goes to the wrong window.

The tells, in rough order of how early you see them:

- `session.json` says renderer URL `:5175` rather than `:5174` - Vite moved up a port, so a previous dev instance never died.
- `connectOverCDP: Timeout 30000ms exceeded` **after** a line reading `<ws connected>`. Connecting works; finding the window does not.
- `Connected to CDP on port 57856 but found no Fleet window at http://localhost:5175` - that sentence is the whole diagnosis.
- `No handler registered for '<channel>'` for channels that plainly exist in source, including pre-existing ones.
- A probe added to main prints nothing at all.

## The routine

Any change under `src/main/` or `src/preload/` needs a full dev restart before it can be verified.
Renderer-only changes do not.

```bash
pkill -f "electron-vite dev"; sleep 1
pkill -f "node_modules/electron/dist/Electron.app"; sleep 3
pgrep -f "MacOS/Electron \." | xargs -r kill -9    # orphans ignore SIGTERM
pgrep -f "node_modules/electron/dist" | wc -l      # must be 0
rm -f .fleet-drive/session.json
nohup npm run dev > /tmp/fleetdev.log 2>&1 &
```

`pkill -f "electron.*fleet"` does not match the dev binary, whose argv is
`node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.
It exits cleanly, reports success, and leaves the process running.

Then prove you are driving the new process before reading anything into its behaviour:

```bash
grep -c "startup marker" /tmp/fleetdev.log        # 1 for a fresh start
lsof -nP -iTCP:57856 -sTCP:LISTEN                 # exactly one LISTEN line
cat .fleet-drive/session.json                     # its pid must equal the LISTEN pid
grep -c "<a distinctive string from your change>" out/main/index.mjs out/preload/index.js
```

A settings key added to `DEFAULT_SETTINGS` is a cheap liveness probe, since main merges defaults on load:

```bash
npm run drive -- eval 'window.fleet.settings.get().then(s => { window.__probe = s.ai.agent })'
npm run drive -- eval 'JSON.stringify(window.__probe)'
```

If the new key is missing, main is stale. Stop and fix that first.

When only part of `out/` is fresh, `rm -rf out node_modules/.vite*` before restarting.

## The rules

1. "The app is running and answering" is not evidence that it is running *your* code.
2. A probe that prints nothing is not evidence. Prove the probe can print at all - restart, watch one known-good line come out - before reading anything into its silence.
3. Before `npm run drive`, check for a live window on the derived port, not for a running dev server. `pgrep "electron-vite dev"` returning nothing does not mean no Electron is running.
4. The dev server belongs to whoever started it. A second `npm run dev` breaks `fleet-drive` - ask before starting one.

## Worth doing

`scripts/drive/core.ts` should compare `session.json`'s `pid` against the process actually listening on the port and refuse to attach on a mismatch, rather than connecting to whatever answers.

## Related

- `docs/learnings/2026-05-30-better-sqlite3-abi-mismatch.md` - hit in the same sessions, and it masks this one. A native-load throw in the `whenReady` bootstrap strips every IPC registration after it, which also presents as `No handler registered`.
- `docs/learnings/2026-08-04-second-dev-server-clobbers-drive-session.md`
