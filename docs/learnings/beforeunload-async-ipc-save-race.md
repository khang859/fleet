# beforeunload async IPC save race

## Problem

The renderer's `beforeunload` handler called `window.fleet.layout.save()` which
internally used `ipcRenderer.invoke` (an async/await round-trip to the main
process). Because `beforeunload` is a synchronous browser event, Electron can
destroy the renderer before the `ipcMain.handle(LAYOUT_SAVE)` response resolves,
silently losing the final workspace save on quit.

A secondary risk: the `ipcMain.on` handler for `LAYOUT_SAVE` used
`event.returnValue` (i.e. `sendSync`), but had no try/catch. If
`layoutStore.save()` threw, the exception would propagate out of the handler
and the renderer would be permanently blocked waiting for a return value.

## Fix

Replace `ipcRenderer.invoke` with `ipcRenderer.sendSync` for `LAYOUT_SAVE` so
the save completes synchronously before the renderer is torn down. The preload
bridge exposes this as a regular function call.

Wrap the `ipcMain.on(LAYOUT_SAVE)` handler body in a try/catch so that any
exception inside `layoutStore.save()` is caught and logged rather than
propagating. Assign `event.returnValue` in both the try and catch branches so
the renderer is never left hanging regardless of outcome.

Also removed a dead-code re-save in `shutdownAll()` that re-called
`layoutStore.save(lastSaved)` — since `lastSaved` is only populated by a
successful prior `save()` call, the re-save was always a no-op and not a true
fallback (it would never fire if the renderer had crashed before saving).

## Lesson

- `beforeunload` is synchronous — any IPC that must complete before the window
  closes must use `sendSync` (or be moved to the main process `before-quit` /
  `will-quit` handlers).
- `ipcMain.on` handlers that use `event.returnValue` must always set
  `event.returnValue` in every code path, including error paths, or the calling
  renderer thread will deadlock.
- A "fallback save" that only fires when a prior save succeeded is not a real
  fallback. True fallback coverage requires intercepting the main-process quit
  lifecycle (e.g. `app.on('before-quit')`) before the renderer is gone.
