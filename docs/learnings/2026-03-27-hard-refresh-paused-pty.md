# Hard refresh causes admiral PTY to freeze permanently

## Symptom

After a hard refresh (Cmd+Shift+R), the admiral Claude session appears stuck — no new
output, no response to input. The sentinel also shows as stopped. Restart doesn't work
from the UI because the status shows "running". Requires a full app exit to recover.

## Root cause

Three interacting bugs:

### 1. `attachOnly` terminals never call `pty.attach()` after reload

In `use-terminal.ts`, the `attachOnly` code path (used by the Admiral terminal) only
registered for live PTY data — it never called `pty.attach()` to drain buffered output.
After a hard refresh, the module-level `createdPtys` Set is cleared, but since `attachOnly`
is true, neither `pty.create()` nor `pty.attach()` was called. If the PTY had been paused
due to buffer overflow during the reload window, it stayed paused permanently.

### 2. `PTY_ATTACH` handler didn't resume paused PTYs

The `PTY_ATTACH` IPC handler drained the output buffer but never checked if the PTY was
paused. Even if `pty.attach()` had been called, a paused PTY (from buffer overflow during
the 500ms reload window) would stay paused.

### 3. Initial admiral wiring didn't forward the `paused` flag

`startAdmiralAndWire()` in `index.ts` sent `PTY_DATA` without the `paused` flag, unlike
`wireAdmiralPty()` in `ipc-handlers.ts`. This meant the renderer never knew the admiral
PTY was paused and never triggered a drain.

## Fix

1. `use-terminal.ts`: `attachOnly` mode now always calls `pty.attach()` to drain buffered
   output (critical for hard refresh recovery).
2. `ipc-handlers.ts`: `PTY_ATTACH` handler now resumes paused PTYs after draining.
3. `index.ts`: `startAdmiralAndWire` now forwards the `paused` flag in PTY_DATA events.
4. `index.ts`: Added `did-finish-load` handler that pushes a fresh starbase snapshot to
   the renderer, so sentinel/navigator/first-officer status restores immediately instead
   of waiting for the next periodic snapshot.

## Key insight

During a hard refresh (~500ms), the PTY continues producing output while the renderer is
dead. The main process flush timer (16ms interval) dutifully sends data via
`webContents.send()` to the dead renderer — the data is lost and the buffer is cleared.
If the PTY buffer overflows (>256KB) during this window, `proc.pause()` is called. After
reload, without an explicit `attach()` + resume, the PTY stays paused forever.
