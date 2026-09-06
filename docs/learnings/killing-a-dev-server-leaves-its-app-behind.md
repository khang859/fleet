# Killing the dev server leaves the Electron app behind

## What happened

A live probe in the main process never printed anything, twice in a row.
The code was right, the app was running, and `npm run drive` answered normally.

`pkill -f "electron-vite dev"` kills the vite process, not the Electron app it launched.
The app keeps running as an orphan with the old bundle in it.
Starting `npm run dev` again then produced a second Electron app, and the two fought over the CDP debug port 57856.

The orphan won, because it bound the port first.
So `npm run drive` was driving the old app the whole time - reading its store, sending its turns - while every edit was landing in the new one.
Nothing errored. The screenshots looked fine. The probe simply never ran.

## The fix

Kill both, and check nothing is left:

```bash
pkill -f "electron-vite dev"; sleep 1
pkill -f "node_modules/electron/dist/Electron.app"; sleep 3
pgrep -f "node_modules/electron/dist" | wc -l   # must be 0
```

Before trusting a probe, confirm the app you are driving is the one holding the port:

```bash
lsof -nP -iTCP:57856 -sTCP:LISTEN
```

One `LISTEN` line, and its PID must be the Electron of the dev server you just started.

## Editing main does not reload main

`electron-vite dev` did not restart the main process when `src/main/agent/responses.ts` changed.
A probe added to main needs a full dev restart to take effect, which is a second way to see nothing and conclude the wrong thing.
The tell is that renderer state survives: if the store still holds the thread from before the edit, main never restarted.

## The rule

A probe that prints nothing is not evidence.
Prove the probe can print at all - restart, watch one known-good line come out - before reading anything into its silence.
