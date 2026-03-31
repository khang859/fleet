# Copilot Custom Claude Configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to configure a custom Claude config directory and binary path (globally and per-workspace), and consolidate all copilot settings into the main Settings tab.

**Architecture:** Extend `CopilotSettings` with new fields (`claudeBinaryPath`, `claudeConfigDir`, `workspaceOverrides`). Refactor `hook-installer.ts` to accept a target config dir parameter. Expand the main Settings → Copilot section with new UI controls. Remove the settings view from the copilot floating window. Wire up PTY spawning to pass resolved config as env vars.

**Tech Stack:** Electron, React, TypeScript, Zustand, electron-store, node-pty

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types.ts` | Modify | Add new fields to `CopilotSettings` |
| `src/shared/constants.ts` | Modify | Add defaults for new fields |
| `src/main/settings-store.ts` | Modify | Deep-merge `workspaceOverrides` in get/set |
| `src/main/copilot/hook-installer.ts` | Modify | Accept custom config dir parameter |
| `src/main/copilot/ipc-handlers.ts` | Modify | Add IPC for workspace list, hook install per-dir |
| `src/main/ipc-handlers.ts` | Modify | Clean up workspace overrides on workspace delete |
| `src/main/pty-manager.ts` | Modify | Resolve and inject `CLAUDE_CONFIG_DIR` + custom binary |
| `src/renderer/src/components/settings/CopilotSection.tsx` | Modify | Full rewrite — all copilot settings + workspace overrides |
| `src/renderer/copilot/src/App.tsx` | Modify | Remove settings view |
| `src/renderer/copilot/src/store/copilot-store.ts` | Modify | Remove settings view from CopilotView type |
| `src/renderer/copilot/src/components/SessionList.tsx` | Modify | Remove settings gear button |
| `src/renderer/copilot/src/components/CopilotSettings.tsx` | Delete | No longer needed |

---

### Task 1: Extend CopilotSettings type and defaults

**Files:**
- Modify: `src/shared/types.ts:165-171`
- Modify: `src/shared/constants.ts:70-76`

- [ ] **Step 1: Add new fields to CopilotSettings type**

In `src/shared/types.ts`, replace the `CopilotSettings` type:

```typescript
export type CopilotWorkspaceOverride = {
  claudeBinaryPath?: string;
  claudeConfigDir?: string;
};

export type CopilotSettings = {
  enabled: boolean;
  autoEnabled: boolean;
  spriteSheet: string;
  notificationSound: string;
  autoStart: boolean;
  claudeBinaryPath: string;
  claudeConfigDir: string;
  workspaceOverrides: Record<string, CopilotWorkspaceOverride>;
};
```

- [ ] **Step 2: Add defaults for new fields**

In `src/shared/constants.ts`, update the copilot defaults:

```typescript
copilot: {
  enabled: false,
  autoEnabled: false,
  spriteSheet: 'officer',
  notificationSound: 'Pop',
  autoStart: false,
  claudeBinaryPath: '',
  claudeConfigDir: '',
  workspaceOverrides: {},
},
```

- [ ] **Step 3: Update settings-store deep merge**

In `src/main/settings-store.ts`, the `get()` method already does `copilot: { ...DEFAULT_SETTINGS.copilot, ...saved.copilot }` which will correctly merge the new fields with defaults. However, `workspaceOverrides` is a nested object that needs to be preserved as-is (not merged key-by-key with defaults), so the existing spread is correct — the saved value replaces the default empty `{}`.

In `set()`, the existing `copilot: { ...current.copilot, ...(partial.copilot ?? {}) }` is also correct — partial updates will merge cleanly.

No code change needed here — verify by reading the file.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Type errors in files that reference CopilotSettings (expected — we'll fix those in later tasks)

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat(copilot): add claudeBinaryPath, claudeConfigDir, workspaceOverrides to CopilotSettings"
```

---

### Task 2: Refactor hook-installer to accept custom config dir

**Files:**
- Modify: `src/main/copilot/hook-installer.ts`

- [ ] **Step 1: Add configDir parameter to all exported functions**

Replace the module-level constants and refactor each function to accept an optional `configDir` parameter. The functions `syncScript`, `isInstalled`, `install`, and `uninstall` should all accept `configDir?: string` and default to `join(homedir(), '.claude')`.

```typescript
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../logger';

const log = createLogger('copilot:hooks');

const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');

// Old Python script name — used for cleanup during migration
const LEGACY_SCRIPT_NAME = 'fleet-copilot.py';
```

Keep `getHookBinaryName()` and `getHookBinarySourcePath()` unchanged.

Add a helper to resolve paths for a given config dir:

```typescript
function resolvePaths(configDir?: string): { claudeDir: string; hooksDir: string; settingsPath: string; hookDest: string } {
  const claudeDir = configDir || DEFAULT_CLAUDE_DIR;
  const hooksDir = join(claudeDir, 'hooks');
  const settingsPath = join(claudeDir, 'settings.json');
  const hookDest = join(hooksDir, getHookBinaryName());
  return { claudeDir, hooksDir, settingsPath, hookDest };
}
```

- [ ] **Step 2: Update syncScript**

```typescript
export function syncScript(configDir?: string): void {
  const { hooksDir, hookDest } = resolvePaths(configDir);
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const source = getHookBinarySourcePath();
  if (!existsSync(source)) {
    log.warn('hook binary source not found, skipping sync', { source });
    return;
  }

  try {
    if (existsSync(hookDest)) {
      const srcContent = readFileSync(source);
      const destContent = readFileSync(hookDest);
      if (srcContent.equals(destContent)) return;
    }

    copyFileSync(source, hookDest);
    chmodSync(hookDest, 0o755);
    log.info('hook binary synced', { dest: hookDest });
  } catch (err) {
    log.error('failed to sync hook binary', { error: String(err) });
  }
}
```

- [ ] **Step 3: Update isInstalled**

```typescript
export function isInstalled(configDir?: string): boolean {
  const { settingsPath, hookDest } = resolvePaths(configDir);
  if (!existsSync(hookDest)) return false;
  if (!existsSync(settingsPath)) return false;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks ?? {};
    return 'SessionStart' in hooks && hasFleetHook(hooks['SessionStart'] ?? []);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Update install**

```typescript
export function install(configDir?: string): void {
  const { hooksDir, settingsPath, hookDest } = resolvePaths(configDir);
  log.info('installing hooks', { configDir: configDir || 'default' });

  // Clean up legacy Python hooks first
  removeLegacyHooks(configDir);

  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const source = getHookBinarySourcePath();
  if (!existsSync(source)) {
    log.error('hook binary source not found', { source });
    throw new Error(`Hook binary not found: ${source}`);
  }
  try {
    copyFileSync(source, hookDest);
    chmodSync(hookDest, 0o755);
    log.info('hook binary installed', { dest: hookDest });
  } catch (err) {
    log.error('failed to copy/chmod hook binary', { error: String(err) });
    throw new Error(`Failed to install hook binary: ${String(err)}`);
  }

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      log.warn('failed to parse existing settings.json, starting fresh');
    }
  }

  const command = hookDest;
  const newEntries = buildHookEntries(command);

  const existingHooks = settings.hooks ?? {};

  for (const [eventName, entries] of Object.entries(newEntries)) {
    const existing = existingHooks[eventName] ?? [];
    if (!hasFleetHook(existing)) {
      existingHooks[eventName] = [...existing, ...entries];
    }
  }

  settings.hooks = existingHooks;
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    log.info('settings.json updated');
  } catch (err) {
    log.error('failed to write settings.json', { error: String(err) });
    throw new Error(`Failed to update settings.json: ${String(err)}`);
  }
}
```

- [ ] **Step 5: Update uninstall**

```typescript
export function uninstall(configDir?: string): void {
  const { hooksDir, settingsPath, hookDest } = resolvePaths(configDir);
  log.info('uninstalling hooks', { configDir: configDir || 'default' });

  if (existsSync(hookDest)) {
    try {
      unlinkSync(hookDest);
    } catch {
      log.warn('failed to remove hook binary');
    }
  }

  // Also clean up legacy Python script if present
  const legacyDest = join(hooksDir, LEGACY_SCRIPT_NAME);
  if (existsSync(legacyDest)) {
    try {
      unlinkSync(legacyDest);
    } catch {
      // ignore
    }
  }

  if (!existsSync(settingsPath)) return;

  try {
    const HOOK_BINARY_NAME = getHookBinaryName();
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks ?? {};

    for (const eventName of Object.keys(hooks)) {
      hooks[eventName] = (hooks[eventName] ?? []).filter(
        (entry) =>
          !entry.hooks.some(
            (h) => h.command.includes(HOOK_BINARY_NAME) || h.command.includes(LEGACY_SCRIPT_NAME)
          )
      );
      if (hooks[eventName].length === 0) {
        delete hooks[eventName];
      }
    }

    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    log.info('settings.json cleaned');
  } catch {
    log.warn('failed to clean settings.json');
  }
}
```

- [ ] **Step 6: Update removeLegacyHooks to accept configDir**

The existing `removeLegacyHooks()` function uses `HOOKS_DIR` and `SETTINGS_PATH`. Update it to accept `configDir?`:

```typescript
function removeLegacyHooks(configDir?: string): void {
  const { hooksDir, settingsPath } = resolvePaths(configDir);
  // ... rest uses hooksDir and settingsPath instead of module constants
}
```

- [ ] **Step 7: Remove module-level CLAUDE_DIR, HOOKS_DIR, SETTINGS_PATH, HOOK_DEST constants**

These are now resolved dynamically via `resolvePaths()`. Delete:

```typescript
// DELETE these lines:
const CLAUDE_DIR = join(homedir(), '.claude');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
```

Also remove the module-level `HOOK_DEST` if it exists (it may be defined after `getHookBinaryName`). Check for `HOOK_BINARY_NAME` — if it's used as a module constant, keep it but reference `getHookBinaryName()` in `uninstall` instead.

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (all callers pass no args, matching the optional parameter)

- [ ] **Step 9: Commit**

```bash
git add src/main/copilot/hook-installer.ts
git commit -m "refactor(copilot): parameterize hook-installer to accept custom config dir"
```

---

### Task 3: Update IPC handlers for custom config dir hooks

**Files:**
- Modify: `src/main/copilot/ipc-handlers.ts`
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add new IPC channel for installing hooks to a specific dir**

In `src/shared/ipc-channels.ts`, add:

```typescript
COPILOT_INSTALL_HOOKS_TO: 'copilot:install-hooks-to',
COPILOT_HOOK_STATUS_FOR: 'copilot:hook-status-for',
```

- [ ] **Step 2: Add IPC handlers**

In `src/main/copilot/ipc-handlers.ts`, add handlers after the existing `COPILOT_HOOK_STATUS` handler:

```typescript
ipcMain.handle(IPC_CHANNELS.COPILOT_INSTALL_HOOKS_TO, async (_event, configDir: string) => {
  log.debug('ipc:copilot:install-hooks-to', { configDir });
  hookInstaller.install(configDir);
  return true;
});

ipcMain.handle(IPC_CHANNELS.COPILOT_HOOK_STATUS_FOR, async (_event, configDir: string) => {
  return hookInstaller.isInstalled(configDir);
});
```

- [ ] **Step 3: Update existing hook handlers to use global config dir**

Update the existing `COPILOT_INSTALL_HOOKS` and `COPILOT_UNINSTALL_HOOKS` handlers to pass the global config dir from settings:

```typescript
ipcMain.handle(IPC_CHANNELS.COPILOT_INSTALL_HOOKS, async () => {
  const settings = settingsStore.get();
  const configDir = settings.copilot.claudeConfigDir || undefined;
  hookInstaller.install(configDir);
  return true;
});

ipcMain.handle(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS, async () => {
  const settings = settingsStore.get();
  const configDir = settings.copilot.claudeConfigDir || undefined;
  hookInstaller.uninstall(configDir);
  return true;
});

ipcMain.handle(IPC_CHANNELS.COPILOT_HOOK_STATUS, async () => {
  const settings = settingsStore.get();
  const configDir = settings.copilot.claudeConfigDir || undefined;
  return hookInstaller.isInstalled(configDir);
});
```

- [ ] **Step 4: Add workspace list IPC handler**

The renderer needs to know which workspaces exist to show the overrides UI. Add a handler (or reuse existing `LAYOUT_LIST`). Since `LAYOUT_LIST` already exists and returns workspaces, no new handler is needed — the renderer can call `window.fleet.layout.list()` to get workspace names/IDs.

No code change needed for this step.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/copilot/ipc-handlers.ts src/shared/ipc-channels.ts
git commit -m "feat(copilot): add IPC handlers for custom config dir hook installation"
```

---

### Task 4: Update preload API

**Files:**
- Modify: `src/preload/copilot.ts`

- [ ] **Step 1: Add new methods to CopilotApi**

In `src/preload/copilot.ts`, add to the `copilotApi` object:

```typescript
installHooksTo: async (configDir: string): Promise<boolean> =>
  typedInvoke(IPC_CHANNELS.COPILOT_INSTALL_HOOKS_TO, configDir),

hookStatusFor: async (configDir: string): Promise<boolean> =>
  typedInvoke(IPC_CHANNELS.COPILOT_HOOK_STATUS_FOR, configDir),
```

Also add these to the `CopilotApi` type interface at the top of the file.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/preload/copilot.ts
git commit -m "feat(copilot): expose installHooksTo and hookStatusFor in preload API"
```

---

### Task 5: Wire PTY spawning to use resolved config

**Files:**
- Modify: `src/main/pty-manager.ts`

- [ ] **Step 1: Add a method to resolve Claude config for a workspace**

The PTY manager needs access to the settings store to resolve per-workspace config. Add a `settingsStore` dependency. Looking at how `PtyManager` is constructed — it has no constructor params currently. The simplest approach is to pass settings store via a setter or have the caller pass resolved env vars in `opts.env`.

Since `PtyCreateOptions` already has an `env` field, the cleanest approach is to have the caller (the IPC handler that creates PTYs) resolve the config and inject `CLAUDE_CONFIG_DIR` into `opts.env`. This avoids coupling `PtyManager` to `SettingsStore`.

Check where PTYs are created from the renderer. In `src/main/ipc-handlers.ts`, find the PTY creation handler:

```typescript
// In the IPC handler that creates PTYs, resolve config before calling ptyManager.create()
```

- [ ] **Step 2: Find and update PTY creation IPC handler**

Search for where `ptyManager.create` is called from IPC handlers. In `src/main/ipc-handlers.ts`, update the PTY creation handler to resolve workspace overrides:

```typescript
// Before the ptyManager.create call, resolve Claude config for the workspace:
const settings = settingsStore.get();
const workspaceId = payload.workspaceId; // need to check if this is available in the payload

// Resolve Claude config: workspace override → global → default
const wsOverride = workspaceId ? settings.copilot.workspaceOverrides[workspaceId] : undefined;
const claudeConfigDir = wsOverride?.claudeConfigDir || settings.copilot.claudeConfigDir || '';
const claudeBinaryPath = wsOverride?.claudeBinaryPath || settings.copilot.claudeBinaryPath || '';

const extraEnv: Record<string, string> = {};
if (claudeConfigDir) {
  extraEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
}
if (claudeBinaryPath) {
  extraEnv.FLEET_CLAUDE_BINARY = claudeBinaryPath;
}

// Pass to ptyManager.create via opts.env
```

**Important:** Check the actual PTY creation payload type (`PtyCreateOptions`) to see if `workspaceId` is already included. If not, add it to `PtyCreateOptions` in `src/shared/types.ts` and pass it from the renderer.

- [ ] **Step 3: Update PtyCreateOptions type if needed**

If `workspaceId` is not in `PtyCreateOptions`, add it:

In `src/shared/types.ts` (or wherever `PtyCreateOptions` is defined — it's in `src/main/pty-manager.ts`):

```typescript
type PtyCreateOptions = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  exitOnComplete?: boolean;
  workspaceId?: string;  // For resolving per-workspace Claude config
};
```

- [ ] **Step 4: Update pty-manager.ts spawn to merge extra env**

In `src/main/pty-manager.ts`, the PTY spawn already uses `opts.env`:

```typescript
env: { ...(opts.env ?? process.env), FLEET_SESSION: '1' }
```

The caller just needs to include `CLAUDE_CONFIG_DIR` in `opts.env`. No change to pty-manager.ts itself — the env merge happens at the call site.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/pty-manager.ts src/main/ipc-handlers.ts
git commit -m "feat(copilot): inject CLAUDE_CONFIG_DIR into PTY env based on workspace config"
```

---

### Task 6: Clean up workspace overrides on workspace delete

**Files:**
- Modify: `src/main/ipc-handlers.ts:186-189`

- [ ] **Step 1: Update LAYOUT_DELETE handler**

In `src/main/ipc-handlers.ts`, the `LAYOUT_DELETE` handler currently just calls `layoutStore.delete(workspaceId)`. Add cleanup of copilot workspace overrides:

```typescript
ipcMain.handle(IPC_CHANNELS.LAYOUT_DELETE, (_event, workspaceId: string) => {
  log.debug('ipc:layout:delete', { workspaceId });
  layoutStore.delete(workspaceId);

  // Clean up copilot workspace overrides
  const settings = settingsStore.get();
  if (settings.copilot.workspaceOverrides[workspaceId]) {
    const { [workspaceId]: _, ...remaining } = settings.copilot.workspaceOverrides;
    settingsStore.set({
      copilot: { ...settings.copilot, workspaceOverrides: remaining }
    });
  }
});
```

Note: `settingsStore` needs to be accessible in this scope. Check how the main IPC handlers file is structured — it likely receives `settingsStore` as a parameter in its setup function. If not, it needs to be passed in.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "feat(copilot): clean up workspace overrides on workspace delete"
```

---

### Task 7: Expand CopilotSection in main Settings

**Files:**
- Modify: `src/renderer/src/components/settings/CopilotSection.tsx`

This is the largest UI task. The current file is 35 lines with just an enabled checkbox. It needs to become a full settings panel.

- [ ] **Step 1: Rewrite CopilotSection with all copilot settings**

Replace the contents of `src/renderer/src/components/settings/CopilotSection.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../../store/settings-store';
import { SettingRow } from './SettingRow';
import type { Workspace } from '../../../../shared/types';

const SYSTEM_SOUNDS = [
  'Pop', 'Ping', 'Tink', 'Glass', 'Blow', 'Bottle', 'Frog',
  'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine', 'Basso',
];

export function CopilotSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [expandedWs, setExpandedWs] = useState<string | null>(null);
  const [hookInstalled, setHookInstalled] = useState(false);
  const [claudeDetected, setClaudeDetected] = useState(true);

  if (!settings) return null;
  if (window.fleet.platform !== 'darwin') return null;

  const s = settings;
  const copilot = s.copilot;

  // Load workspaces and hook status
  useEffect(() => {
    window.fleet.layout.list().then((res) => setWorkspaces(res.workspaces)).catch(() => {});
    if (window.copilot) {
      window.copilot.hookStatus().then(setHookInstalled).catch(() => {});
      window.copilot.serviceStatus().then((st) => {
        setHookInstalled(st.hookInstalled);
        setClaudeDetected(st.claudeDetected);
      }).catch(() => {});
    }
  }, []);

  const updateCopilot = useCallback((patch: Partial<typeof copilot>) => {
    void updateSettings({ copilot: { ...copilot, ...patch } });
  }, [copilot, updateSettings]);

  const handleBrowseBinary = async (): Promise<void> => {
    const paths = await window.fleet.file.openDialog({});
    if (paths.length > 0) {
      updateCopilot({ claudeBinaryPath: paths[0] });
    }
  };

  const handleBrowseConfigDir = async (): Promise<void> => {
    const dir = await window.fleet.showFolderPicker();
    if (dir) {
      updateCopilot({ claudeConfigDir: dir });
    }
  };

  const handleInstallHooks = async (): Promise<void> => {
    if (!window.copilot) return;
    await window.copilot.installHooks();
    setHookInstalled(true);
  };

  const handleUninstallHooks = async (): Promise<void> => {
    if (!window.copilot) return;
    await window.copilot.uninstallHooks();
    setHookInstalled(false);
  };

  const updateWorkspaceOverride = (wsId: string, patch: { claudeBinaryPath?: string; claudeConfigDir?: string }) => {
    const current = copilot.workspaceOverrides[wsId] ?? {};
    const updated = { ...current, ...patch };
    // Remove override entirely if both fields are empty
    const isEmpty = !updated.claudeBinaryPath && !updated.claudeConfigDir;
    const newOverrides = { ...copilot.workspaceOverrides };
    if (isEmpty) {
      delete newOverrides[wsId];
    } else {
      newOverrides[wsId] = updated;
    }
    updateCopilot({ workspaceOverrides: newOverrides });
  };

  const handleBrowseWsBinary = async (wsId: string): Promise<void> => {
    const paths = await window.fleet.file.openDialog({});
    if (paths.length > 0) {
      updateWorkspaceOverride(wsId, { claudeBinaryPath: paths[0] });
    }
  };

  const handleBrowseWsConfigDir = async (wsId: string): Promise<void> => {
    const dir = await window.fleet.showFolderPicker();
    if (dir) {
      updateWorkspaceOverride(wsId, { claudeConfigDir: dir });
    }
  };

  const hasOverride = (wsId: string): boolean => {
    const ov = copilot.workspaceOverrides[wsId];
    return !!ov && !!(ov.claudeBinaryPath || ov.claudeConfigDir);
  };

  return (
    <div className="space-y-6">
      {/* Enable Copilot */}
      <div>
        <SettingRow label="Enable Copilot">
          <input
            type="checkbox"
            checked={copilot.enabled}
            onChange={(e) => updateCopilot({ enabled: e.target.checked })}
            className="accent-blue-500"
          />
        </SettingRow>
        <p className="text-xs text-neutral-500 mt-1">
          Show the Copilot overlay window on macOS. Copilot watches your active agent sessions and
          surfaces status, permissions, and quick actions in a floating panel.
        </p>
      </div>

      {/* Notification Sound */}
      <div>
        <SettingRow label="Notification Sound">
          <select
            value={copilot.notificationSound}
            onChange={(e) => updateCopilot({ notificationSound: e.target.value })}
            className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
          >
            <option value="">None</option>
            {SYSTEM_SOUNDS.map((sound) => (
              <option key={sound} value={sound}>{sound}</option>
            ))}
          </select>
        </SettingRow>
        <p className="text-xs text-neutral-500 mt-1">
          Sound played when an agent needs attention.
        </p>
      </div>

      {/* Claude Code Binary Path */}
      <div>
        <label className="text-sm text-neutral-300 block mb-1">Claude Code Binary</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={copilot.claudeBinaryPath}
            onChange={(e) => updateCopilot({ claudeBinaryPath: e.target.value })}
            placeholder="/usr/local/bin/claude"
            className="flex-1 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
          />
          <button
            onClick={() => void handleBrowseBinary()}
            className="px-2 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
          >
            Browse
          </button>
        </div>
        <p className="text-xs text-neutral-500 mt-1">
          Path to the Claude Code binary. Leave empty to use the system PATH.
        </p>
      </div>

      {/* Config Directory */}
      <div>
        <label className="text-sm text-neutral-300 block mb-1">Config Directory</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={copilot.claudeConfigDir}
            onChange={(e) => updateCopilot({ claudeConfigDir: e.target.value })}
            placeholder="~/.claude"
            className="flex-1 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
          />
          <button
            onClick={() => void handleBrowseConfigDir()}
            className="px-2 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
          >
            Browse
          </button>
        </div>
        <p className="text-xs text-neutral-500 mt-1">
          Claude Code config directory. Leave empty to use the default (~/.claude).
        </p>
      </div>

      {/* Claude Code Hooks */}
      <div>
        <label className="text-sm text-neutral-300 block mb-1">Claude Code Hooks</label>
        {!claudeDetected && (
          <div className="rounded bg-amber-900/30 border border-amber-700/50 px-2 py-1.5 mb-2">
            <span className="text-xs text-amber-400 block font-medium">Claude Code not found</span>
            <span className="text-xs text-amber-400/70 block">
              Install it with: npm install -g @anthropic-ai/claude-code
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${hookInstalled ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-sm text-neutral-300">
            {hookInstalled ? 'Installed' : 'Not installed'}
          </span>
          <button
            onClick={() => void (hookInstalled ? handleUninstallHooks() : handleInstallHooks())}
            className="px-2 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
          >
            {hookInstalled ? 'Uninstall' : 'Install'}
          </button>
        </div>
        {!hookInstalled && (
          <p className="text-xs text-neutral-500 mt-1">
            Hooks are required for Fleet to monitor your Claude Code sessions.
          </p>
        )}
      </div>

      {/* Workspace Overrides */}
      <div>
        <label className="text-sm text-neutral-300 block mb-1">Workspace Overrides</label>
        <p className="text-xs text-neutral-500 mb-2">
          Override global Claude settings per workspace.
        </p>
        {workspaces.length === 0 ? (
          <p className="text-xs text-neutral-600 italic">No workspaces configured.</p>
        ) : (
          <div className="space-y-1">
            {workspaces.map((ws) => {
              const isExpanded = expandedWs === ws.id;
              const override = copilot.workspaceOverrides[ws.id] ?? {};
              return (
                <div key={ws.id} className="border border-neutral-700 rounded">
                  <button
                    onClick={() => setExpandedWs(isExpanded ? null : ws.id)}
                    className="w-full flex items-center justify-between px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800/50"
                  >
                    <span className="flex items-center gap-2">
                      {ws.label}
                      {hasOverride(ws.id) && (
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                      )}
                    </span>
                    <span className="text-neutral-600 text-xs">{isExpanded ? '▲' : '▼'}</span>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-3 border-t border-neutral-700/50">
                      <div className="pt-2">
                        <label className="text-xs text-neutral-400 block mb-1">Claude Code Binary</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={override.claudeBinaryPath ?? ''}
                            onChange={(e) => updateWorkspaceOverride(ws.id, { claudeBinaryPath: e.target.value })}
                            placeholder="Use global default"
                            className="flex-1 bg-neutral-800 text-xs text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
                          />
                          <button
                            onClick={() => void handleBrowseWsBinary(ws.id)}
                            className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
                          >
                            Browse
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-neutral-400 block mb-1">Config Directory</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={override.claudeConfigDir ?? ''}
                            onChange={(e) => updateWorkspaceOverride(ws.id, { claudeConfigDir: e.target.value })}
                            placeholder="Use global default"
                            className="flex-1 bg-neutral-800 text-xs text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
                          />
                          <button
                            onClick={() => void handleBrowseWsConfigDir(ws.id)}
                            className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
                          >
                            Browse
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/CopilotSection.tsx
git commit -m "feat(copilot): expand CopilotSection with all settings and workspace overrides"
```

---

### Task 8: Remove settings from copilot floating window

**Files:**
- Modify: `src/renderer/copilot/src/App.tsx`
- Modify: `src/renderer/copilot/src/store/copilot-store.ts`
- Modify: `src/renderer/copilot/src/components/SessionList.tsx`
- Delete: `src/renderer/copilot/src/components/CopilotSettings.tsx`

- [ ] **Step 1: Remove 'settings' from CopilotView type**

In `src/renderer/copilot/src/store/copilot-store.ts`, change:

```typescript
type CopilotView = 'sessions' | 'detail' | 'settings' | 'mascots';
```

to:

```typescript
type CopilotView = 'sessions' | 'detail' | 'mascots';
```

- [ ] **Step 2: Remove settings view from App.tsx**

In `src/renderer/copilot/src/App.tsx`:

Remove the import:
```typescript
import { CopilotSettings } from './components/CopilotSettings';
```

Remove the settings view from the render:
```typescript
{view === 'settings' && <CopilotSettings />}
```

- [ ] **Step 3: Remove settings gear button from SessionList**

In `src/renderer/copilot/src/components/SessionList.tsx`, find and remove the button that navigates to settings:

```tsx
<Button variant="ghost" size="icon" onClick={() => setView('settings')}>
```

Remove this button and its associated icon import (likely `Settings` from lucide-react).

- [ ] **Step 4: Delete CopilotSettings.tsx**

Delete the file: `src/renderer/copilot/src/components/CopilotSettings.tsx`

- [ ] **Step 5: Remove settings-related methods from copilot store if unused**

Check if `loadSettings`, `updateSettings`, `installHooks`, `uninstallHooks` in the copilot store are still used elsewhere (e.g., by the mascot picker or session list). If `loadSettings` is still called in `App.tsx` useEffect, keep it. Only remove methods that are exclusively used by the deleted `CopilotSettings` component.

`loadSettings` is called in `App.tsx` line 61 — keep it.
`updateSettings` may still be used by `MascotPicker` — check before removing.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(copilot): remove settings panel from copilot floating window"
```

---

### Task 9: Final integration and typecheck

**Files:** None new — just verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS with no errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS — full build completes

- [ ] **Step 4: Commit any remaining fixes**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix(copilot): resolve build issues from custom config integration"
```
