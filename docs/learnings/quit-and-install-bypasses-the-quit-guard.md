# `quitAndInstall` is not a request to quit

Found while making the update nudge visible.
The nudge itself was the feature; this was the thing that made it unsafe to ship the nudge without touching the install path.

## What was wrong

`Restart to Update` called `updater.quitAndInstall()` directly, and that call is not the polite "please quit" it reads as.

`node_modules/electron-updater/out/BaseUpdater.js:12-26` - the Windows and Linux path - is:

```js
quitAndInstall(isSilent = false, isForceRunAfter = false) {
  const isInstalled = this.install(...)   // spawns the installer
  if (isInstalled) {
    setImmediate(() => { ...; this.app.quit() })   // and only then asks to quit
  }
}
```

So the installer is already running by the time `app.quit()` fires.
Fleet's own `close` handler then sees running agents, calls `event.preventDefault()`, and puts up the "work is still running" dialog from #554 - *after* the app has begun being replaced.
Answering "cancel" there left the window open, `quitAndInstallCalled` latched `true`, and the install proceeding underneath it.

macOS is worse rather than better: `MacUpdater.quitAndInstall` hands off to native Squirrel, which does not go through the window's `close` at all, so there is no dialog and nothing to cancel.

None of this was reachable often enough to notice, because the button lived two clicks deep in Settings behind a 6px unlabelled dot.
Making the nudge prominent is exactly what would have turned it into a common path.

## The second half: `autoInstallOnAppQuit`

`autoDownload` and `autoInstallOnAppQuit` were both left at electron-updater's `true` defaults, and nothing in the repo set either.

`BaseUpdater.addQuitHandler` (line 68) attaches an `app.onQuit` hook the moment a download finishes.
That means a staged update installs itself on *any* quit - including one the user is still being asked to confirm, and one they then cancel, since cancelling is `preventDefault` on the window's close and not a promise that no quit is in flight.

## The fix

Set `autoInstallOnAppQuit = false` so quit-time installation is the app's decision, then ask before spawning anything:

```ts
async function requestInstallUpdate(): Promise<void> {
  if (installRequested) return;
  if (hasRunningWork(true) && !(await quitGuard.ask(mainOwnedWork(true)))) return;
  installRequested = true;
  quitConfirmed = true;
  (await getUpdater()).quitAndInstall();
}
```

`quitConfirmed = true` is what makes the close that `quitAndInstall` triggers internally fall through to `ptyManager.killAll()` instead of asking a second question.

The non-obvious part is the reset.
An install that fails never quits - `install()` returns false, `dispatchError` fires, and the app carries on - so a `quitConfirmed` left set would make the *next* close of the window skip the running-work question entirely and silently.
The updater's own `error` handler puts both flags back:

```ts
autoUpdater.on('error', (err) => {
  if (installRequested) { installRequested = false; quitConfirmed = false }
  ...
})
```

## How to see any of this

`npm run drive -- fixture update-ready` asks *main* to emit a synthetic `ready` status through the real `sendUpdateStatus`, so the whole path downstream of `electron-updater` is exercised without publishing a release.

In dev the install then fails with "No update filepath provided", which is not a dead end - it is the error path, and running it is how the reset above gets tested.
The check that matters afterwards is that closing the window still prompts.

Two things caught me out while testing it:

- A pane running `sleep 300` is **not** "running work". `ActivityTracker` drives `working` from output, not from process presence (`activity-tracker.ts`, `onData`/`onSilence`), and process polling is deliberately only a confirming signal. A silent command leaves the pane `idle` and the guard correctly does not fire. Use something chatty - `while true; do echo working; sleep 0.4; done`.
- `text=Restart to Update` matches the release notes as well as the button once the notes mention the button. Use `role=button[name="Restart to Update"]`.
