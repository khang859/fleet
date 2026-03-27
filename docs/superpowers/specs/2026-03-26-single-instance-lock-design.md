# Single Instance Lock for Fleet

**Date:** 2026-03-26
**Status:** Approved

## Problem

Fleet's socket API uses a single well-known path (`~/.fleet/fleet.sock` on macOS/Linux, `\\.\pipe\fleet` on Windows). If a user opens a second Fleet instance, it calls `unlinkSync` on the existing socket file during startup, breaking the first instance's CLI communication. Both instances then race for the same path.

## Approach: Electron Single Instance Lock

Use Electron's built-in `app.requestSingleInstanceLock()` to prevent multiple Fleet instances from running simultaneously. This is the standard pattern used by VS Code, Slack, and Discord.

Fleet already supports multiple projects via tabs and workspaces within a single instance, so there is no user-facing need for multiple processes.

## Design

### Single change in `src/main/index.ts`

Add the lock acquisition **before** `app.whenReady()`:

```typescript
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, _argv, _workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // ... existing app.whenReady() and everything else
}
```

### Behavior

| Scenario | Result |
|---|---|
| User opens Fleet while it's already running | Existing window focuses; second process quits |
| User runs `fleet` CLI while app is running | Works as before (single socket, no conflict) |
| User runs `fleet` CLI with no app running | CLI retry logic handles `ECONNREFUSED` as before |
| First instance crashes | Lock auto-cleaned by OS; next launch starts fresh |

### What does NOT change

- `SocketServer`, `SocketSupervisor`, `fleet-cli.ts`, `constants.ts` — no modifications needed
- Socket path stays `~/.fleet/fleet.sock` — single instance means no collision
- CLI discovery — still connects to the well-known path

### Platform behavior

- **macOS/Linux:** Chromium creates a Unix domain socket + symlink in the user data dir. On crash, the next launch checks if the lock-holder PID is still alive (~20s recovery).
- **Windows:** Uses a named mutex + lock file with `FILE_FLAG_DELETE_ON_CLOSE` for instant crash recovery.

### Constraints

- `requestSingleInstanceLock()` must be called before `app.whenReady()` to avoid a race window
- Fleet does not distribute via Mac App Store (sandbox issues don't apply)
- Fleet has a unique app name (no cross-app lock interference)

### Future extensibility

If multi-instance is ever needed (e.g., per-workspace isolation), the cleanest upgrade path is the tmux named-socket pattern: `~/.fleet/sockets/<name>.sock` with a `default` socket, and `--socket <name>` on the CLI. But this is not needed now — tabs and workspaces cover multi-project use cases.

## Files to modify

1. `src/main/index.ts` — add lock acquisition + `second-instance` handler (~15 lines)
