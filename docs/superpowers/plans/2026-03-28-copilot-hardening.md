# Copilot Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all validated failure-handling and edge-case issues in the copilot enable/disable lifecycle, hook installation, and UI feedback.

**Architecture:** Replace the boolean `servicesRunning` flag with a state machine (`idle` / `starting` / `running` / `stopping`) to serialize enable/disable operations. Add timeouts to async teardown. Wrap all unguarded filesystem/lifecycle calls in try/catch. Surface actionable error states in the copilot UI.

**Tech Stack:** Electron (main process), React + Zustand (renderer), node `net` module (socket server), `fs` (hook installer)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/main/copilot/index.ts` | Modify | State machine, serialized toggle, try/catch wrappers |
| `src/main/copilot/socket-server.ts` | Modify | Timeout on `stop()`, graceful pending socket shutdown |
| `src/main/copilot/hook-installer.ts` | Modify | try/catch filesystem ops, logging in `syncScript()` |
| `src/main/copilot/session-store.ts` | Modify | Add `clear()` method |
| `src/shared/ipc-channels.ts` | Modify | Add `COPILOT_SERVICE_STATUS` channel |
| `src/renderer/copilot/src/components/CopilotSettings.tsx` | Modify | Better hook error feedback |
| `src/renderer/copilot/src/components/SessionList.tsx` | Modify | Better empty state with hook/Claude guidance |
| `src/renderer/copilot/src/store/copilot-store.ts` | Modify | Track `serviceStatus` from main |
| `src/preload/copilot.ts` | Modify (if needed) | Expose `serviceStatus` IPC |

---

### Task 1: Add `clear()` to session store

**Files:**
- Modify: `src/main/copilot/session-store.ts:48-173`

- [ ] **Step 1: Add `clear()` method to `CopilotSessionStore`**

In `src/main/copilot/session-store.ts`, add this method to the class after `removePermission()` (after line 153):

```typescript
clear(): void {
  this.sessions.clear();
  this.toolUseIdCache.clear();
  log.info('session store cleared');
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/main/copilot/session-store.ts
git commit -m "feat(copilot): add clear() method to session store"
```

---

### Task 2: Add timeout to socket server `stop()`

**Files:**
- Modify: `src/main/copilot/socket-server.ts:56-79`

- [ ] **Step 1: Replace `stop()` with timeout-protected version**

Replace the existing `stop()` method (lines 56-79) with:

```typescript
async stop(): Promise<void> {
  // Send graceful end to pending sockets before destroying
  for (const [, pending] of this.pendingSockets) {
    try {
      pending.socket.end();
    } catch {
      // socket may already be closed
    }
  }
  // Give clients 500ms to receive the FIN, then force-destroy
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const [, pending] of this.pendingSockets) {
    try {
      pending.socket.destroy();
    } catch {
      // ignore
    }
  }
  this.pendingSockets.clear();

  if (!this.server) return;

  const STOP_TIMEOUT_MS = 5000;
  await Promise.race([
    new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.cleanupSocket();
        log.info('socket server stopped');
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        log.warn('socket server stop timed out, forcing cleanup');
        this.cleanupSocket();
        resolve();
      }, STOP_TIMEOUT_MS);
    }),
  ]);
  this.server = null;
}

private cleanupSocket(): void {
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // ignore
    }
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/copilot/socket-server.ts
git commit -m "fix(copilot): add timeout to socket server stop and graceful client shutdown"
```

---

### Task 3: Wrap filesystem ops in hook-installer and add logging

**Files:**
- Modify: `src/main/copilot/hook-installer.ts:136-207`

- [ ] **Step 1: Add logging to `syncScript()` when binary is missing**

Replace line 140 (`if (!existsSync(source)) return;`) with:

```typescript
if (!existsSync(source)) {
  log.warn('hook binary source not found, skipping sync', { source });
  return;
}
```

- [ ] **Step 2: Wrap filesystem operations in `syncScript()` with try/catch**

Replace lines 142-150 (the `if (existsSync(HOOK_DEST))` block through the `copyFileSync`/`chmodSync`/`log.info`) with:

```typescript
try {
  if (existsSync(HOOK_DEST)) {
    const srcContent = readFileSync(source);
    const destContent = readFileSync(HOOK_DEST);
    if (srcContent.equals(destContent)) return;
  }

  copyFileSync(source, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  log.info('hook binary synced', { dest: HOOK_DEST });
} catch (err) {
  log.error('failed to sync hook binary', { error: String(err) });
}
```

- [ ] **Step 3: Wrap filesystem operations in `install()` with try/catch**

Replace lines 179-181 (the `copyFileSync`/`chmodSync`/`log.info` block) with:

```typescript
try {
  copyFileSync(source, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  log.info('hook binary installed', { dest: HOOK_DEST });
} catch (err) {
  log.error('failed to copy/chmod hook binary', { error: String(err) });
  throw new Error(`Failed to install hook binary: ${String(err)}`);
}
```

Replace line 205 (the `writeFileSync` for settings.json) with:

```typescript
try {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  log.info('settings.json updated');
} catch (err) {
  log.error('failed to write settings.json', { error: String(err) });
  throw new Error(`Failed to update settings.json: ${String(err)}`);
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/copilot/hook-installer.ts
git commit -m "fix(copilot): wrap filesystem ops in try/catch and add sync logging"
```

---

### Task 4: State machine and serialized toggle in copilot index

This is the core fix. Replace the boolean `servicesRunning` with a state machine and serialize enable/disable operations.

**Files:**
- Modify: `src/main/copilot/index.ts:1-143`

- [ ] **Step 1: Replace the module-level state and add state machine**

Replace lines 14-20 (the module-level variables from `let sessionStore` through `let cachedSettingsStore`) with:

```typescript
type CopilotServiceState = 'idle' | 'starting' | 'running' | 'stopping';

let sessionStore: CopilotSessionStore | null = null;
let socketServer: CopilotSocketServer | null = null;
let copilotWindow: CopilotWindow | null = null;
let conversationReader: ConversationReader | null = null;
let serviceState: CopilotServiceState = 'idle';
let cachedSettingsStore: SettingsStore | null = null;
/** Queued toggle to run after current transition completes */
let pendingToggle: boolean | null = null;
```

- [ ] **Step 2: Replace `onCopilotSettingsChanged()` with serialized version**

Replace lines 51-62 (the `onCopilotSettingsChanged` function) with:

```typescript
/** Called from IPC when user toggles copilot enabled in settings */
export async function onCopilotSettingsChanged(): Promise<void> {
  if (!cachedSettingsStore) return;
  const settings = cachedSettingsStore.get();
  const wantEnabled = settings.copilot.enabled;
  log.info('copilot settings changed', { enabled: wantEnabled, serviceState });

  // If currently transitioning, queue the desired state
  if (serviceState === 'starting' || serviceState === 'stopping') {
    pendingToggle = wantEnabled;
    log.info('queued toggle (transition in progress)', { pendingToggle });
    return;
  }

  if (wantEnabled && serviceState === 'idle') {
    await startCopilotServices();
  } else if (!wantEnabled && serviceState === 'running') {
    await stopCopilotServices();
  }
}

async function drainPendingToggle(): Promise<void> {
  if (pendingToggle === null) return;
  const wantEnabled = pendingToggle;
  pendingToggle = null;
  log.info('draining pending toggle', { wantEnabled, serviceState });

  if (wantEnabled && serviceState === 'idle') {
    await startCopilotServices();
  } else if (!wantEnabled && serviceState === 'running') {
    await stopCopilotServices();
  }
}
```

- [ ] **Step 3: Replace `startCopilotServices()` with state-machine version**

Replace lines 64-123 (the entire `startCopilotServices` function) with:

```typescript
async function startCopilotServices(): Promise<void> {
  if (!sessionStore || !socketServer || !copilotWindow) {
    log.error('startCopilotServices: missing dependencies', {
      hasSessionStore: !!sessionStore,
      hasSocketServer: !!socketServer,
      hasCopilotWindow: !!copilotWindow,
    });
    return;
  }

  serviceState = 'starting';
  log.info('starting copilot services');

  conversationReader?.setOnChange((sessionId, messages) => {
    copilotWindow?.send(IPC_CHANNELS.COPILOT_CHAT_UPDATED, { sessionId, messages });
  });

  sessionStore.setOnChange(() => {
    copilotWindow?.send(IPC_CHANNELS.COPILOT_SESSIONS, sessionStore!.getSessions());

    if (conversationReader) {
      const activeSessions = sessionStore!.getSessions();
      const activeIds = new Set(activeSessions.map(s => s.sessionId));

      for (const watchedId of conversationReader.getWatchedSessionIds()) {
        if (activeIds.has(watchedId)) {
          conversationReader.refresh(watchedId);
        } else {
          conversationReader.unwatch(watchedId);
        }
      }
    }
  });

  // Hook installation failure should not prevent copilot from starting —
  // the socket server and window are still useful for manual hook install later
  if (!hookInstaller.isInstalled()) {
    try {
      log.info('installing hooks');
      hookInstaller.install();
    } catch (err) {
      log.error('failed to install hooks', { error: String(err) });
    }
  } else {
    try {
      hookInstaller.syncScript();
    } catch (err) {
      log.error('failed to sync hook script', { error: String(err) });
    }
  }

  try {
    log.info('starting socket server');
    await socketServer.start();
  } catch (err) {
    log.error('failed to start socket server', { error: String(err) });
    serviceState = 'idle';
    await drainPendingToggle();
    return;
  }

  try {
    log.info('creating copilot window');
    copilotWindow.create();
  } catch (err) {
    log.error('failed to create copilot window', { error: String(err) });
    // Socket is running but window failed — stop socket too
    await socketServer.stop();
    serviceState = 'idle';
    await drainPendingToggle();
    return;
  }

  serviceState = 'running';
  log.info('copilot started successfully');
  await drainPendingToggle();
}
```

- [ ] **Step 4: Replace `stopCopilotServices()` with state-machine version**

Replace lines 125-138 (the entire `stopCopilotServices` function) with:

```typescript
async function stopCopilotServices(): Promise<void> {
  serviceState = 'stopping';
  log.info('stopping copilot services');

  if (socketServer) {
    try {
      await socketServer.stop();
    } catch (err) {
      log.error('error stopping socket server', { error: String(err) });
    }
  }
  if (copilotWindow) {
    try {
      copilotWindow.destroy();
    } catch (err) {
      log.error('error destroying copilot window', { error: String(err) });
    }
  }
  if (conversationReader) {
    try {
      conversationReader.dispose();
    } catch (err) {
      log.error('error disposing conversation reader', { error: String(err) });
    }
  }
  if (sessionStore) {
    sessionStore.clear();
  }

  serviceState = 'idle';
  log.info('copilot services stopped');
  await drainPendingToggle();
}
```

- [ ] **Step 5: Update `stopCopilot()` export and `initCopilot` check**

Replace line 43 (`if (!settings.copilot.enabled)`) check to also use `serviceState`:

The existing code at lines 43-46 already gates on settings, so no change needed there. But in `initCopilot`, after `await startCopilotServices()` (line 48), no change is needed since `startCopilotServices` now manages `serviceState` internally.

The `stopCopilot()` export at lines 140-142 is fine as-is since it calls `stopCopilotServices()`.

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/copilot/index.ts
git commit -m "fix(copilot): replace boolean flag with state machine and serialize toggle operations"
```

---

### Task 5: Add `COPILOT_SERVICE_STATUS` IPC channel and expose hook failure state

**Files:**
- Modify: `src/shared/ipc-channels.ts:58-72`
- Modify: `src/main/copilot/ipc-handlers.ts:49-174`

- [ ] **Step 1: Add new IPC channel**

In `src/shared/ipc-channels.ts`, after the `COPILOT_FOCUS_TERMINAL` line (line 72), add:

```typescript
  COPILOT_SERVICE_STATUS: 'copilot:service-status',
```

- [ ] **Step 2: Add IPC handler for service status**

In `src/main/copilot/ipc-handlers.ts`, after the `COPILOT_HOOK_STATUS` handler (after line 98), add:

```typescript
  ipcMain.handle(IPC_CHANNELS.COPILOT_SERVICE_STATUS, () => {
    return {
      hookInstalled: hookInstaller.isInstalled(),
      claudeDetected: isClaudeInstalled(),
    };
  });
```

- [ ] **Step 3: Add `isClaudeInstalled()` helper at top of ipc-handlers.ts**

After the existing imports (after line 12), add:

```typescript
import { execSync } from 'child_process';
```

Wait — `execSync` is already imported on line 2. So after the `log` declaration (after line 13), add:

```typescript
function isClaudeInstalled(): boolean {
  try {
    execSync('claude --version', { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/copilot/ipc-handlers.ts
git commit -m "feat(copilot): add service status IPC channel with Claude detection"
```

---

### Task 6: Expose service status in copilot preload

**Files:**
- Modify: `src/preload/copilot.ts` (need to check this file first)

- [ ] **Step 1: Read the preload file and add the new API**

First read `src/preload/copilot.ts` to see the existing pattern.

Add a new method to the exposed API following the same pattern as the existing methods:

```typescript
serviceStatus: (): Promise<{ hookInstalled: boolean; claudeDetected: boolean }> =>
  ipcRenderer.invoke('copilot:service-status'),
```

Add this alongside the existing `hookStatus` method.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/preload/copilot.ts
git commit -m "feat(copilot): expose service status in copilot preload"
```

---

### Task 7: Update copilot store to track service status

**Files:**
- Modify: `src/renderer/copilot/src/store/copilot-store.ts:19-138`

- [ ] **Step 1: Add service status state and action**

In the `CopilotStoreState` type (around line 19), add after `hookInstalled: boolean;` (line 27):

```typescript
claudeDetected: boolean;
```

In the initial state (around line 59), add after `hookInstalled: false,`:

```typescript
claudeDetected: true, // optimistic default
```

- [ ] **Step 2: Update `loadSettings` to also fetch service status**

Replace the `loadSettings` method (lines 85-90) with:

```typescript
loadSettings: async () => {
  const settings = await window.copilot.getSettings();
  const hookInstalled = await window.copilot.hookStatus();
  let claudeDetected = true;
  try {
    const status = await window.copilot.serviceStatus();
    claudeDetected = status.claudeDetected;
  } catch {
    // serviceStatus not available (older preload), assume true
  }
  log.debug('loadSettings', { settings, hookInstalled, claudeDetected });
  set({ settings, hookInstalled, claudeDetected });
},
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/copilot/src/store/copilot-store.ts
git commit -m "feat(copilot): track Claude detection status in copilot store"
```

---

### Task 8: Improve CopilotSettings UI feedback

**Files:**
- Modify: `src/renderer/copilot/src/components/CopilotSettings.tsx:91-116`

- [ ] **Step 1: Add Claude detection info and better hook error state**

Replace lines 91-116 (the `{/* Claude Code Hooks */}` section) with:

```tsx
            {/* Claude Code Status */}
            {!claudeDetected && (
              <div className="rounded bg-amber-900/30 border border-amber-700/50 px-2 py-1.5">
                <span className="text-[10px] text-amber-400 block font-medium mb-0.5">
                  Claude Code not found
                </span>
                <span className="text-[10px] text-amber-400/70 block">
                  Install it with: npm install -g @anthropic-ai/claude-code
                </span>
              </div>
            )}

            {/* Claude Code Hooks */}
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <label className="text-[10px] text-neutral-400 block mb-1 cursor-help">
                    Claude Code Hooks
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  Hooks let Fleet monitor Claude Code sessions for permissions and status changes
                </TooltipContent>
              </Tooltip>
              <div className="flex items-center gap-2">
                <Badge status={hookInstalled ? 'complete' : 'error'} />
                <span className="text-xs text-neutral-300">
                  {hookInstalled ? 'Installed' : 'Not installed'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={hookInstalled ? uninstallHooks : installHooks}
                >
                  {hookInstalled ? 'Uninstall' : 'Install'}
                </Button>
              </div>
              {!hookInstalled && (
                <span className="text-[10px] text-neutral-500 block mt-1">
                  Hooks are required for Fleet to monitor your Claude Code sessions.
                </span>
              )}
            </div>
```

- [ ] **Step 2: Add `claudeDetected` to the component's store selectors**

At the top of the `CopilotSettings` function (after the existing `useCopilotStore` selectors, around line 26), add:

```typescript
const claudeDetected = useCopilotStore((s) => s.claudeDetected);
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/copilot/src/components/CopilotSettings.tsx
git commit -m "fix(copilot): show actionable feedback for missing Claude Code and hooks"
```

---

### Task 9: Improve SessionList empty state

**Files:**
- Modify: `src/renderer/copilot/src/components/SessionList.tsx:84-89`

- [ ] **Step 1: Replace generic empty state with contextual guidance**

Add store selector at top of `SessionList` function (after existing selectors, around line 60):

```typescript
const hookInstalled = useCopilotStore((s) => s.hookInstalled);
const claudeDetected = useCopilotStore((s) => s.claudeDetected);
```

Replace lines 84-89 (the empty state `div`) with:

```tsx
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-xs px-4 text-center py-8 gap-2">
              {!claudeDetected ? (
                <>
                  <span>Claude Code is not installed.</span>
                  <span className="text-[10px] text-neutral-600">
                    npm install -g @anthropic-ai/claude-code
                  </span>
                </>
              ) : !hookInstalled ? (
                <>
                  <span>Hooks not installed.</span>
                  <span className="text-[10px] text-neutral-600">
                    Go to Settings to install Claude Code hooks.
                  </span>
                </>
              ) : (
                <>
                  <span>No active Claude Code sessions.</span>
                  <span className="text-[10px] text-neutral-600">
                    Start a session to see it here.
                  </span>
                </>
              )}
            </div>
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/SessionList.tsx
git commit -m "fix(copilot): show contextual guidance in empty session list"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS with no errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit any lint fixes if needed**

```bash
git add -A
git commit -m "chore: lint fixes from copilot hardening"
```
