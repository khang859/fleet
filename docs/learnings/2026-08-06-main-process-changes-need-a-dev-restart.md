# A main-process change does not reach the running window, and the E2E check silently tests the old code

Date: 2026-08-06

## What happened

While verifying the Agent pane's spend accounting, I added a fix in `src/main/agent/agent-service.ts` so that a cancelled turn still reports what its completed rounds had cost.
Unit tests passed.
The E2E check through `fleet-drive` - start a multi-round turn, cancel it, read `thread.spend` - showed the total unchanged, exactly as if the fix did nothing.

The fix was fine.
The running Electron main process was still executing the code from before the edit.

## Why it happened

`npm run dev` (`electron-vite dev`) did not rebuild or restart the main process when a file under `src/main/` changed.
Confirmed twice, on two separate dev servers, by appending a comment to a main-process file and watching the log:

```
builds 1 -> 1; startups 1 -> 1
```

Neither `electron main process built successfully` nor the app's own `startup marker` line appeared again.
The renderer hot-reloads normally, which is what makes this so easy to miss: UI edits appear instantly, so the dev server *looks* live.

## Why it is dangerous

This produces a **false negative**, which is the worst shape a verification failure can take.
The check runs, the app responds, nothing errors - and the answer is about code that is no longer on disk.
A false negative here invites exactly the wrong response: going back to "fix" working code.

## How to avoid it

Any change under `src/main/` or `src/preload/` needs a full dev restart before it can be verified through `fleet-drive`:

```bash
pkill -f "electron-vite dev"
pkill -f "node_modules/electron/dist/Electron.app"
pgrep -f "MacOS/Electron \." | xargs -r kill -9   # orphans ignore SIGTERM
nohup npm run dev > /tmp/fleetdev.log 2>&1 &
```

Then confirm the process you are about to drive is the new one:

```bash
grep -c "startup marker" /tmp/fleetdev.log   # should be 1 for a fresh start
cat .fleet-drive/session.json                # pid must be the new Electron
```

Renderer-only changes (`src/renderer/`) do not need this.

## Lesson

Before trusting an E2E result about main-process behaviour, prove the process under test contains the change.
"The app is running and answering" is not evidence that it is running *your* code.

## Related

- `docs/learnings/2026-08-05-fleet-drive-stale-electron-steals-port.md` - the neighbouring trap: `fleet-drive` attaching to an orphaned Electron on the derived debug port. Same class of failure (driving the wrong process), different cause, and the same cure: kill every Electron main, start exactly one, verify the pid.
- `docs/learnings/2026-08-04-second-dev-server-clobbers-drive-session.md`
