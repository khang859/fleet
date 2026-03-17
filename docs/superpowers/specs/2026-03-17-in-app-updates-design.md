# In-App Update Checker

Add an "Updates" tab to the Settings modal so users can manually check for updates, see download progress and release notes, and install updates — all without leaving the app.

## Current State

Fleet already has `electron-updater` wired up:
- Main process calls `autoUpdater.checkForUpdatesAndNotify()` on launch (packaged builds only)
- Preload exposes `onUpdateDownloaded` and `installUpdate`
- App.tsx shows a floating "Update ready — restart to install" button

The problem: there's no way to know if the updater is working, what version you're on, or to manually trigger a check.

## Design

### Update States

| State | Trigger | UI |
|---|---|---|
| `idle` | Default / after `not-available` auto-resets (3s) | Version label + "Check for Updates" button |
| `checking` | User clicks check or auto-check on launch | "Checking for updates..." |
| `downloading` | `update-available` fires (auto-download is on, so this is immediate) | Progress bar with percentage + release notes |
| `ready` | Download complete | "Restart to Update" button + release notes |
| `not-available` | Already on latest | "You're up to date" (auto-resets to `idle` after 3s) |
| `error` | Network/auth/signing failure | Error message + "Retry" button |

Note: `electron-updater` auto-starts downloading when `update-available` fires (`autoDownload` defaults to `true`). There is no separate `available` state — the UI goes straight from `checking` to `downloading` with version/release notes shown alongside the progress bar.

### IPC Channels

- `fleet:update-check` — renderer invokes to trigger manual check
- `fleet:update-status` — main sends status updates to renderer

Payload shape:
```ts
type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; releaseNotes: string; percent: number }
  | { state: 'ready'; version: string; releaseNotes: string }
  | { state: 'not-available' }
  | { state: 'error'; message: string };
```

Existing channel stays:
- `fleet:install-update` — renderer sends to quit and install

New channel:
- `fleet:get-version` — renderer invokes, main returns `app.getVersion()`

### Main Process (`src/main/index.ts`)

Replace the current ~10-line updater block. Wire all `electron-updater` events into a single `fleet:update-status` sender:

- `checking-for-update` → send `{ state: 'checking' }`
- `update-available` → stash `version` and `releaseNotes` for use in `download-progress` events, then send `{ state: 'downloading', version, releaseNotes, percent: 0 }`
- `download-progress` → send `{ state: 'downloading', version, releaseNotes, percent }`
- `update-downloaded` → send `{ state: 'ready', version, releaseNotes }`
- `update-not-available` → send `{ state: 'not-available' }`
- `error` → send `{ state: 'error', message }`

**`releaseNotes` normalization:** `electron-updater`'s `UpdateInfo.releaseNotes` can be `string | ReleaseNoteInfo[] | null`. Normalize to a plain string: if array, join `.note` fields with newlines; if null, use empty string.

**`fleet:update-check` handler:** Wrap `autoUpdater.checkForUpdates()` in a try/catch. On error, send `{ state: 'error', message }` via `fleet:update-status` rather than letting the rejection propagate. Ignore the call if already in `checking` or `downloading` state (debounce).

Add `ipcMain.handle('fleet:get-version')` that returns `app.getVersion()`.

Keep silent auto-check on launch — it feeds into the same status pipeline.

**Cleanup:** Remove the old `fleet:update-downloaded` send and `fleet:install-update` ipcMain.on listener. Replace the latter with the same channel name but keep the behavior (`autoUpdater.quitAndInstall()`).

### Preload (`src/preload/index.ts`)

Replace the `updates` object (removing the old `onUpdateDownloaded` and its `fleet:update-downloaded` listener):
```ts
updates: {
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('fleet:update-check'),
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
    const handler = (_e, status) => callback(status);
    ipcRenderer.on('fleet:update-status', handler);
    return () => ipcRenderer.removeListener('fleet:update-status', handler);
  },
  installUpdate: (): void => ipcRenderer.send('fleet:install-update'),
  getVersion: (): Promise<string> => ipcRenderer.invoke('fleet:get-version'),
},
```

### Settings Modal (`src/renderer/src/components/SettingsModal.tsx`)

Add `'updates'` to the tab list. Tab content:

1. **Version label** — "Fleet v1.5.0" (fetched via `getVersion()` on mount)
2. **Check button** — "Check for Updates" (disabled while checking/downloading)
3. **Status text** — inline, reacts to update state
4. **Progress bar** — visible during `downloading` state, shows percentage
5. **Release notes** — scrollable box (max ~150px), visible when `downloading` or `ready`
6. **Restart button** — "Restart to Update", visible when `ready`
7. **Error display** — error message + "Retry" button when `error`

Download continues in the background if user closes Settings — the App-level listener still tracks status.

### App.tsx Changes

- Remove the floating "Update ready" bottom-right button and the `useEffect` that listens to the old `fleet:update-downloaded` channel
- Listen for `fleet:update-status` at App level to set a boolean `updateReady` (when `state === 'ready'`)
- Both App.tsx and SettingsModal independently subscribe to `fleet:update-status` — this is intentional (multiple IPC listeners are fine)
- When `updateReady` is true, show a passive update indicator. Since there is no gear icon in the Sidebar currently, add a small "Update available" badge/dot to the sidebar footer area (near the bottom of the sidebar)

### What's NOT in scope

- No native menu bar "Check for Updates" item (can add later)
- No auto-update toggle in settings (always checks on launch)
- No update channel selector (stable only)
- No delta updates — full download each time (electron-updater default)

### Known Prerequisite

`electron-builder.yml` has `publish.owner: OWNER` — this must be set to the actual GitHub owner (`khang859`) for the updater to find releases. This is a config fix, not a code change.
