# In-App Update Checker Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Updates" tab to the Settings modal where users can manually check for updates, see download progress with release notes, and install updates.

**Architecture:** Expand the existing `electron-updater` wiring in the main process to forward all lifecycle events via a unified `fleet:update-status` IPC channel. The preload layer exposes a richer API, and the Settings modal adds an "Updates" tab that renders state-driven UI. App.tsx listens at the top level for a passive "update ready" indicator in the sidebar.

**Tech Stack:** electron-updater (already installed), Electron IPC, React state

---

## File Map

| File                                            | Action                             | Responsibility                                             |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `src/shared/types.ts`                           | Modify                             | Add `UpdateStatus` type union                              |
| `src/main/index.ts`                             | Modify (lines 308-321)             | Replace updater block with full event wiring               |
| `src/preload/index.ts`                          | Modify (lines 93-101)              | Replace `updates` object with richer API                   |
| `src/renderer/src/components/SettingsModal.tsx` | Modify                             | Add `updates` tab with status UI                           |
| `src/renderer/src/App.tsx`                      | Modify (lines 55, 95-101, 284-293) | Switch to new `onUpdateStatus` API, remove floating button |
| `src/renderer/src/components/Sidebar.tsx`       | Modify (bottom section)            | Add update-ready indicator                                 |
| `electron-builder.yml`                          | Modify (line 54)                   | Fix `publish.owner` placeholder                            |

---

### Task 1: Add UpdateStatus Type

**Files:**

- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add the UpdateStatus type to shared types**

Add at the end of `src/shared/types.ts`:

```ts
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; releaseNotes: string; percent: number }
  | { state: 'ready'; version: string; releaseNotes: string }
  | { state: 'not-available' }
  | { state: 'error'; message: string };
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (new type is unused so far, no errors)

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(updates): add UpdateStatus type union"
```

---

### Task 2: Wire Main Process Update Events

**Files:**

- Modify: `src/main/index.ts` (lines 308-321)

- [ ] **Step 1: Replace the updater block in main/index.ts**

Replace lines 308-321 (the current auto-updater section) with:

```ts
// --- Auto-updater: unified status pipeline ---
let updateState: 'idle' | 'checking' | 'downloading' | 'ready' = 'idle';
let pendingVersion = '';
let pendingReleaseNotes = '';

function normalizeReleaseNotes(notes: string | Array<{ note: string }> | null | undefined): string {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map((n) => n.note).join('\n');
  return '';
}

function sendUpdateStatus(status: import('../shared/types').UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fleet:update-status', status);
  }
}

autoUpdater.on('checking-for-update', () => {
  updateState = 'checking';
  sendUpdateStatus({ state: 'checking' });
});

autoUpdater.on('update-available', (info) => {
  updateState = 'downloading';
  pendingVersion = info.version;
  pendingReleaseNotes = normalizeReleaseNotes(
    info.releaseNotes as string | Array<{ note: string }> | null
  );
  sendUpdateStatus({
    state: 'downloading',
    version: pendingVersion,
    releaseNotes: pendingReleaseNotes,
    percent: 0
  });
});

autoUpdater.on('download-progress', (progress) => {
  sendUpdateStatus({
    state: 'downloading',
    version: pendingVersion,
    releaseNotes: pendingReleaseNotes,
    percent: Math.round(progress.percent)
  });
});

autoUpdater.on('update-downloaded', () => {
  updateState = 'ready';
  sendUpdateStatus({
    state: 'ready',
    version: pendingVersion,
    releaseNotes: pendingReleaseNotes
  });
});

autoUpdater.on('update-not-available', () => {
  updateState = 'idle';
  sendUpdateStatus({ state: 'not-available' });
});

autoUpdater.on('error', (err) => {
  updateState = 'idle';
  sendUpdateStatus({ state: 'error', message: err?.message ?? 'Unknown error' });
});

ipcMain.handle('fleet:update-check', async () => {
  if (updateState === 'checking' || updateState === 'downloading') return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    sendUpdateStatus({
      state: 'error',
      message: err instanceof Error ? err.message : 'Update check failed'
    });
  }
});

ipcMain.handle('fleet:get-version', () => app.getVersion());

ipcMain.on('fleet:install-update', () => {
  autoUpdater.quitAndInstall();
});

// Silent check on launch (packaged builds only)
if (app.isPackaged) {
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Auto-update check failed:', err);
  });
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(updates): wire all electron-updater events to unified IPC pipeline"
```

---

### Task 3: Update Preload API

**Files:**

- Modify: `src/preload/index.ts` (lines 93-101)

- [ ] **Step 1: Replace the updates object in preload/index.ts**

Replace lines 93-101 (the current `updates` block) with:

```ts
  updates: {
    checkForUpdates: (): Promise<void> =>
      ipcRenderer.invoke('fleet:update-check'),
    onUpdateStatus: (callback: (status: import('../shared/types').UpdateStatus) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, status: import('../shared/types').UpdateStatus) =>
        callback(status);
      ipcRenderer.on('fleet:update-status', handler);
      return () => ipcRenderer.removeListener('fleet:update-status', handler);
    },
    installUpdate: (): void =>
      ipcRenderer.send('fleet:install-update'),
    getVersion: (): Promise<string> =>
      ipcRenderer.invoke('fleet:get-version'),
  },
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS. The `FleetApi` type is inferred from the `fleetApi` object, so `env.d.ts` picks up the new shape automatically.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(updates): replace preload updates API with richer status listener"
```

---

### Task 4: Add Updates Tab to Settings Modal

**Files:**

- Modify: `src/renderer/src/components/SettingsModal.tsx`

- [ ] **Step 1: Add the updates tab and UI**

In `SettingsModal.tsx`, make these changes:

1. Add imports at the top:

```ts
import { useState, useEffect } from 'react';
import type { UpdateStatus } from '../../../shared/types';
```

(Note: `useState` is already imported — just add `useEffect` and the type import.)

2. Change the `activeTab` type and tabs array (line 38 and 65):

```ts
const [activeTab, setActiveTab] = useState<
  'general' | 'notifications' | 'socket' | 'visualizer' | 'updates'
>('general');
```

```ts
const tabs = ['general', 'notifications', 'socket', 'visualizer', 'updates'] as const;
```

3. Add state for the updates tab inside `SettingsModal`, after the existing `activeTab` state:

```ts
const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
const [appVersion, setAppVersion] = useState('');

useEffect(() => {
  window.fleet.updates.getVersion().then(setAppVersion);
}, []);

useEffect(() => {
  const cleanup = window.fleet.updates.onUpdateStatus((status) => {
    setUpdateStatus(status);
    // Auto-reset "not-available" back to idle after 3 seconds
    if (status.state === 'not-available') {
      setTimeout(() => setUpdateStatus({ state: 'idle' }), 3000);
    }
  });
  return () => {
    cleanup();
  };
}, []);
```

4. Add the updates tab content after the visualizer tab content (before the closing `</div>` of the content area):

```tsx
{
  activeTab === 'updates' && (
    <div className="space-y-4">
      <div className="text-sm text-neutral-300">Fleet v{appVersion}</div>

      {/* Check / Retry / Restart button */}
      {updateStatus.state === 'ready' ? (
        <button
          onClick={() => window.fleet.updates.installUpdate()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
        >
          Restart to Update
        </button>
      ) : (
        <button
          onClick={() => window.fleet.updates.checkForUpdates()}
          disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
          className="px-3 py-1.5 text-sm bg-neutral-700 hover:bg-neutral-600 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {updateStatus.state === 'checking' ? 'Checking...' : 'Check for Updates'}
        </button>
      )}

      {/* Status display */}
      {updateStatus.state === 'not-available' && (
        <div className="text-sm text-green-400">You're up to date.</div>
      )}

      {updateStatus.state === 'error' && (
        <div className="text-sm text-red-400">{updateStatus.message}</div>
      )}

      {/* Download progress */}
      {updateStatus.state === 'downloading' && (
        <div className="space-y-2">
          <div className="text-sm text-neutral-300">
            Downloading v{updateStatus.version}... {updateStatus.percent}%
          </div>
          <div className="w-full h-1.5 bg-neutral-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${updateStatus.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* Ready state */}
      {updateStatus.state === 'ready' && (
        <div className="text-sm text-blue-400">v{updateStatus.version} is ready to install.</div>
      )}

      {/* Release notes */}
      {(updateStatus.state === 'downloading' || updateStatus.state === 'ready') &&
        updateStatus.releaseNotes && (
          <div className="mt-2">
            <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">
              Release Notes
            </div>
            <div className="text-sm text-neutral-400 bg-neutral-800 rounded-md p-3 max-h-[150px] overflow-y-auto whitespace-pre-wrap border border-neutral-700">
              {updateStatus.releaseNotes}
            </div>
          </div>
        )}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Verify dev build renders**

Run: `npm run dev`
Expected: Settings modal opens, "updates" tab appears in tab bar, clicking it shows version and "Check for Updates" button.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(updates): add Updates tab to Settings modal with status UI"
```

---

### Task 5: Update App.tsx — Remove Old Updater, Add Passive Indicator

**Files:**

- Modify: `src/renderer/src/App.tsx` (lines 55, 95-101, 284-293)

- [ ] **Step 1: Replace the old auto-updater useEffect and floating button**

1. Replace the auto-updater useEffect (lines 95-101) with:

```ts
// Auto-updater — track if update is ready for sidebar indicator
useEffect(() => {
  const cleanup = window.fleet.updates.onUpdateStatus((status) => {
    setUpdateReady(status.state === 'ready');
  });
  return () => {
    cleanup();
  };
}, []);
```

2. Remove the floating update button block (lines 284-293 — the `{updateReady && (` block through its closing `)}`)

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(updates): switch App.tsx to unified update status listener, remove floating button"
```

---

### Task 6: Add Update Indicator to Sidebar

**Files:**

- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/App.tsx` (pass prop)

- [ ] **Step 1: Add updateReady prop to Sidebar**

In `Sidebar.tsx`, change the component signature:

```ts
export function Sidebar({ updateReady }: { updateReady?: boolean }) {
```

Add an update indicator at the very bottom of the sidebar, after the workspaces section's closing `</div>` and before the outermost closing `</div>` (line 475-476):

```tsx
{
  /* Update indicator */
}
{
  updateReady && (
    <div className="border-t border-neutral-800 px-3 py-2">
      <button
        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-neutral-800 rounded-md transition-colors"
        onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-settings'))}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
        Update available
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Pass updateReady from App.tsx to Sidebar**

In `App.tsx`, change:

```tsx
<Sidebar />
```

to:

```tsx
<Sidebar updateReady={updateReady} />
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx
git commit -m "feat(updates): add update-ready indicator to sidebar footer"
```

---

### Task 7: Fix electron-builder.yml Owner Placeholder

**Files:**

- Modify: `electron-builder.yml` (line 54)

- [ ] **Step 1: Replace the placeholder owner**

In `electron-builder.yml`, change:

```yaml
owner: OWNER
```

to:

```yaml
owner: khang859
```

- [ ] **Step 2: Commit**

```bash
git add electron-builder.yml
git commit -m "fix(build): set correct GitHub owner for auto-updater publish config"
```

---

### Task 8: Manual Smoke Test

No code changes — verification only.

- [ ] **Step 1: Run dev build**

Run: `npm run dev`

- [ ] **Step 2: Open Settings modal, click "Updates" tab**

Expected: Shows "Fleet v1.5.0" (or current version) and "Check for Updates" button.

- [ ] **Step 3: Click "Check for Updates"**

Expected: Button shows "Checking...", then after a moment either:

- "You're up to date." (if no new release exists), which fades back to idle after 3s
- Download progress with percentage (if an update is available)
- Error message (if not packaged / no GitHub releases — expected in dev mode)

- [ ] **Step 4: Verify sidebar indicator does NOT appear in dev mode**

Expected: No "Update available" in sidebar (only shows when `state === 'ready'`).

- [ ] **Step 5: Verify the old floating "Update ready" button is gone**

Expected: No blue button in the bottom-right corner.
