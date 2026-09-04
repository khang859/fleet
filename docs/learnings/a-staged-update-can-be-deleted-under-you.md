# A staged update can be deleted under you

Found in review of the update nudge, one round after [`quit-and-install-bypasses-the-quit-guard`](./quit-and-install-bypasses-the-quit-guard.md).
Same feature, and the same shape of mistake: treating an `electron-updater` call as if it meant the polite thing it reads as.

## What was wrong

The pill, the sidebar dot and the install button hung off a `staged` value in the renderer store, kept there for every status that was not `ready`:

```ts
setStatus: (status) =>
  set(status.state === 'ready' ? { status, staged: {...} } : { status })
```

That rule exists for a good reason - a check now runs every four hours, so the first one to fail offline must not take the install button down with it and strand an update that is sitting on disk.
But "not `ready`" is not the same as "the file is still there", and the store had no way to tell the difference.

`electron-updater` keeps exactly one downloaded artifact, in one `pending` directory, and later work in that directory destroys it:

- `DownloadedUpdateHelper.getValidCachedUpdateFile` (`DownloadedUpdateHelper.js:113`) calls `cleanCacheDirForPendingUpdate()` - an `emptyDir` - as soon as it is asked for a build whose sha512 differs from the cached one. So the moment a *different* version starts downloading, the staged installer is already gone.
- `AppUpdater.executeDownload` (`AppUpdater.js:607`) wraps the download in `catch { await removeFileIfAny() }`, and `removeFileIfAny` calls `downloadedUpdateHelper.clear()`, which empties the directory again *and* nulls `_file`.
- `BaseUpdater.installPath` is just `downloadedUpdateHelper.file` (`BaseUpdater.js:38`), so once that is null the install dispatches `No update filepath provided, can't quit and install`.

So: version A downloads and is staged. Four hours later a check finds B and starts downloading it - A's installer is deleted. B's download then fails - the directory is emptied a second time.
The app went on showing "v2.113.0 is ready to install", and pressing it errored.
Worse, Settings *replaces* "Check for Updates" with "Restart to Update" while something is staged, so the one control that could have recovered from this was the one being hidden by the stale state.

## The fix

Move the decision to the main process and send it with every status.
Main is the only side that sees the sequence, and the sequence is what distinguishes an error that deleted the artifact from one that did not:

```ts
// src/main/update-staging.ts
case 'downloading':
  return staged?.version === next.version ? staged : null;
case 'error':
  return previous.state === 'downloading' ? null : staged;
```

An error after `checking` is a metadata failure - offline, rate-limited - and touched no files, so the staged update survives it.
An error after `downloading` ran through `removeFileIfAny`, so it did not.

The renderer store became a mirror of `{ status, staged }` rather than something that derives one from the other.
That also fixed a smaller bug nobody had reported: main does not repeat itself, so a renderer reload used to lose the pill until the next check hours later.
With main holding the snapshot, the renderer asks for it once on mount (`IPC_CHANNELS.UPDATE_SNAPSHOT`).

`requestInstallUpdate` also returns early when nothing is staged, so an install request that cannot succeed never asks the user to throw running work away first.

## The general lesson

State that says "you can do X now" has to be invalidated by whatever destroys X, not by whatever *mentions* X.
Deriving it from a status stream works only if every event that changes the underlying resource is in that stream - and here the destructive events (`emptyDir`, `clear()`) are internal to the library and surface only as an incidental `error`, which also means a dozen harmless things.

## How to see it

`npm run drive -- fixture update-superseded` plays the whole sequence: staged 2.113.0, then 2.114.0 downloading at 1.5s, then a failed download at 3s.
The pill should disappear rather than offer an install that would fail, and the Updates page should go back to an enabled `Check for Updates` with the error under it.

One process note that cost more time than the bug: `npm run drive` attached to an Electron instance left running from a *previous* session, which had grabbed the single-instance lock, so the freshly built main never started and the payloads coming back were the old shape.
`ps -o lstart= -p <pid>` on the electron process is the quick check - see [`fleet-drive-stale-electron-steals-port`](./2026-08-05-fleet-drive-stale-electron-steals-port.md).
