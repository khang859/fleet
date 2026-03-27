# Admiral Terminal State Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monitor Admiral PTY output to detect Claude Code states (thinking, speaking, tool execution, permission, error, idle) and drive admiral avatar + sidebar status text in real-time.

**Architecture:** New `AdmiralStateDetector` class in the main process scans every PTY data flush for Claude Code TUI patterns, debounces state transitions, and emits events via the existing `EventBus`. The renderer subscribes via a new IPC channel and updates the Zustand store, which drives `AdmiralSidebar` re-renders.

**Tech Stack:** Electron IPC, EventBus, Zustand, regex pattern matching, node-pty data stream

**Spec:** `docs/superpowers/specs/2026-03-18-admiral-state-detection-design.md`

---

## File Map

| Action | File                                                                | Responsibility                                                                                |
| ------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Create | `src/main/starbase/admiral-state-detector.ts`                       | Core detection logic — ANSI stripping, pattern matching, idle timer, debounce, event emission |
| Modify | `src/main/event-bus.ts:4-12`                                        | Add `admiral-state-change` to `FleetEvent` union                                              |
| Modify | `src/shared/constants.ts:5-52`                                      | Add `ADMIRAL_STATE_CHANGED` to `IPC_CHANNELS`                                                 |
| Modify | `src/shared/ipc-api.ts`                                             | Add `AdmiralStatePayload` type                                                                |
| Modify | `src/main/index.ts:44-54`                                           | Instantiate `AdmiralStateDetector`, wire to data handlers and cleanup                         |
| Modify | `src/main/ipc-handlers.ts:33-51,213-229`                            | Accept detector param, call `scan()` in `wireAdmiralPty()`                                    |
| Modify | `src/preload/index.ts:92-101`                                       | Add `onStateChanged` listener                                                                 |
| Modify | `src/renderer/src/store/star-command-store.ts:27-69`                | Add `admiralStatusText` field and `setAdmiralState` action                                    |
| Modify | `src/renderer/src/components/StarCommandTab.tsx:29-84`              | Subscribe to state change IPC, update store                                                   |
| Modify | `src/renderer/src/components/star-command/AdmiralSidebar.tsx:30-71` | Display dynamic `admiralStatusText`                                                           |

---

### Task 1: Add `admiral-state-change` event to EventBus

**Files:**

- Modify: `src/main/event-bus.ts:4-12`

- [ ] **Step 1: Add the new event type to the FleetEvent union**

In `src/main/event-bus.ts`, add a new union member after the existing `agent-state-change` line:

```typescript
// Add after line 9: | { type: 'agent-state-change'; paneId: string; state: string; tool?: string }
| { type: 'admiral-state-change'; state: 'standby' | 'thinking' | 'speaking' | 'alert'; statusText: string }
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/khangnguyen/Development/fleet && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds with no type errors

- [ ] **Step 3: Commit**

```bash
git add src/main/event-bus.ts
git commit -m "feat(starbase): add admiral-state-change event type to EventBus"
```

---

### Task 2: Add IPC channel constant and payload type

**Files:**

- Modify: `src/shared/constants.ts:47`
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add `ADMIRAL_STATE_CHANGED_DETAIL` to IPC_CHANNELS**

In `src/shared/constants.ts`, add a new entry after `ADMIRAL_STATUS_CHANGED` (line 47). Note: `ADMIRAL_STATUS_CHANGED` already exists for lifecycle status (running/stopped/starting). The new channel is for detailed state (thinking/speaking/etc):

```typescript
ADMIRAL_STATE_DETAIL: 'admiral:state-detail',
```

- [ ] **Step 2: Add `AdmiralStateDetailPayload` type**

In `src/shared/ipc-api.ts`, add at the end of the file:

```typescript
export type AdmiralStateDetailPayload = {
  state: 'standby' | 'thinking' | 'speaking' | 'alert';
  statusText: string;
};
```

- [ ] **Step 3: Verify build compiles**

Run: `cd /Users/khangnguyen/Development/fleet && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/shared/constants.ts src/shared/ipc-api.ts
git commit -m "feat(starbase): add ADMIRAL_STATE_DETAIL IPC channel and payload type"
```

---

### Task 3: Create `AdmiralStateDetector` class

**Files:**

- Create: `src/main/starbase/admiral-state-detector.ts`

- [ ] **Step 1: Create the detector file with full implementation**

Create `src/main/starbase/admiral-state-detector.ts`:

```typescript
import { EventBus } from '../event-bus';

type AdmiralAvatarState = 'standby' | 'thinking' | 'speaking' | 'alert';

export interface AdmiralStateEvent {
  state: AdmiralAvatarState;
  statusText: string;
}

// Strip ANSI escape sequences before pattern matching
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Thinking — braille spinner characters used by Claude Code
const THINKING_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

// Tool execution — Claude Code tool use headers
const TOOL_RE =
  /⏺\s+(Bash|Read|Edit|Write|Glob|Grep|MultiEdit|TodoWrite|WebFetch|WebSearch|Agent|Skill|NotebookEdit)/;

// Permission prompt patterns
const PERMISSION_RES = [
  /Do you want to (?:allow|proceed|continue)/i,
  /\(y\/n\)\s*$/,
  /Allow this action\?/i,
  /Press Enter to confirm/i
];

// Error patterns
const ERROR_RES = [/^Error:/m, /connection failed/i, /fatal:/i, /SIGTERM|SIGKILL/];

const IDLE_TIMEOUT_MS = 2000;
const DEBOUNCE_MS = 200;
const MAX_BUFFER = 1024;

export class AdmiralStateDetector {
  private eventBus: EventBus;
  private admiralPaneId: string | null = null;
  private buffer = '';
  private currentState: AdmiralAvatarState = 'standby';
  private currentStatusText = 'Standing by';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  setAdmiralPaneId(paneId: string | null): void {
    this.admiralPaneId = paneId;
    this.buffer = '';
    this.clearTimers();
    if (paneId === null) {
      // Admiral stopped — handled by reset()
    }
  }

  scan(paneId: string, data: string): void {
    if (paneId !== this.admiralPaneId) return;

    // Strip ANSI and append to rolling buffer
    const clean = data.replace(ANSI_RE, '');
    this.buffer += clean;
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(-MAX_BUFFER);
    }

    // Reset idle timer on any output
    this.resetIdleTimer();

    // Detect state from cleaned data (priority order)
    const detected = this.detect(clean);
    if (detected) {
      this.transition(detected.state, detected.statusText);
    }
  }

  reset(): void {
    this.buffer = '';
    this.clearTimers();
    this.emitImmediate('standby', 'Standing by');
  }

  dispose(): void {
    this.clearTimers();
  }

  private detect(clean: string): AdmiralStateEvent | null {
    // Priority 1: Permission prompt
    for (const re of PERMISSION_RES) {
      if (re.test(clean)) {
        return { state: 'alert', statusText: 'Awaiting permission' };
      }
    }

    // Priority 1: Error
    for (const re of ERROR_RES) {
      if (re.test(clean)) {
        return { state: 'alert', statusText: 'Error' };
      }
    }

    // Priority 2: Tool execution
    const toolMatch = TOOL_RE.exec(clean);
    if (toolMatch) {
      return { state: 'thinking', statusText: `Executing: ${toolMatch[1]}` };
    }

    // Priority 3: Thinking (spinner)
    if (THINKING_RE.test(clean)) {
      return { state: 'thinking', statusText: 'Thinking...' };
    }

    // Priority 4: Speaking (any non-whitespace output that didn't match above)
    if (clean.trim().length > 0) {
      return { state: 'speaking', statusText: 'Speaking' };
    }

    return null;
  }

  private transition(state: AdmiralAvatarState, statusText: string): void {
    // Alert bypasses debounce
    if (state === 'alert') {
      this.emitImmediate(state, statusText);
      return;
    }

    // Same state — skip (but update statusText if different, e.g. different tool name)
    if (state === this.currentState && statusText === this.currentStatusText) {
      return;
    }

    // Debounce non-alert transitions
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.emitImmediate(state, statusText);
    }, DEBOUNCE_MS);
  }

  private emitImmediate(state: AdmiralAvatarState, statusText: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.currentState = state;
    this.currentStatusText = statusText;
    this.eventBus.emit('admiral-state-change', {
      type: 'admiral-state-change',
      state,
      statusText
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Idle bypasses debounce (2s silence is sufficient debouncing)
      this.emitImmediate('standby', 'Standing by');
    }, IDLE_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
```

- [ ] **Step 2: Verify build compiles**

Run: `cd /Users/khangnguyen/Development/fleet && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/main/starbase/admiral-state-detector.ts
git commit -m "feat(starbase): add AdmiralStateDetector for PTY output state detection"
```

---

### Task 4: Wire detector into main process

**Files:**

- Modify: `src/main/index.ts:44-54` (instantiation)
- Modify: `src/main/index.ts:262-286` (startAdmiralAndWire — add scan call)
- Modify: `src/main/index.ts:251-259` (admiral status change — add reset call)
- Modify: `src/main/index.ts:643-656` (cleanup — add dispose call)

- [ ] **Step 1: Import and instantiate AdmiralStateDetector**

In `src/main/index.ts`, add import after line 28 (`import { AdmiralProcess } from './starbase/admiral-process'`):

```typescript
import { AdmiralStateDetector } from './starbase/admiral-state-detector';
```

Add instantiation after line 54 (`const jsonlWatcher = ...`):

```typescript
const admiralStateDetector = new AdmiralStateDetector(eventBus);
```

- [ ] **Step 2: Call `scan()` in `startAdmiralAndWire` data handler**

In `src/main/index.ts`, inside the `startAdmiralAndWire` function, modify the `ptyManager.onData` callback (around line 266-271). Add `admiralStateDetector.scan(paneId, data)` alongside the existing `notificationDetector.scan(paneId, data)`:

```typescript
ptyManager.onData(paneId, (data) => {
  notificationDetector.scan(paneId, data);
  admiralStateDetector.scan(paneId, data);
  const w = mainWindow;
  if (w && !w.isDestroyed()) {
    w.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId, data });
  }
});
```

- [ ] **Step 3: Set paneId after Admiral starts**

In `startAdmiralAndWire`, after `const paneId = await admiralProcess!.start()` (line 264), add:

```typescript
admiralStateDetector.setAdmiralPaneId(paneId);
```

- [ ] **Step 4: Reset detector on Admiral stop**

In the `admiralProcess.setOnStatusChange` callback (around line 251-259), add reset logic when status is 'stopped':

```typescript
admiralProcess.setOnStatusChange((status, error) => {
  if (status === 'stopped') {
    admiralStateDetector.reset();
    admiralStateDetector.setAdmiralPaneId(null);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.ADMIRAL_STATUS_CHANGED, {
      status,
      paneId: admiralProcess!.paneId,
      error
    });
  }
});
```

- [ ] **Step 5: Forward admiral-state-change events to renderer**

After the existing `eventBus.on('agent-state-change', ...)` block (around line 416-422), add:

```typescript
// Forward admiral state detail changes to renderer
eventBus.on('admiral-state-change', (event) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, {
      state: event.state,
      statusText: event.statusText
    });
  }
});
```

- [ ] **Step 6: Dispose detector on window-all-closed**

In the `window-all-closed` handler (around line 643-656), add after `admiralProcess?.stop()`:

```typescript
admiralStateDetector.dispose();
```

- [ ] **Step 7: Verify build compiles**

Run: `cd /Users/khangnguyen/Development/fleet && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(starbase): wire AdmiralStateDetector into main process lifecycle"
```

---

### Task 5: Wire detector into ipc-handlers `wireAdmiralPty`

**Files:**

- Modify: `src/main/ipc-handlers.ts:33-51` (add param)
- Modify: `src/main/ipc-handlers.ts:213-229` (add scan call)

- [ ] **Step 1: Import AdmiralStateDetector type**

Add import at top of `src/main/ipc-handlers.ts` after line 27:

```typescript
import type { AdmiralStateDetector } from './starbase/admiral-state-detector';
```

- [ ] **Step 2: Add parameter to registerIpcHandlers**

Add `admiralStateDetector` parameter after `retentionService` (line 51):

```typescript
retentionService?: RetentionService | null,
admiralStateDetector?: AdmiralStateDetector | null
```

- [ ] **Step 3: Add scan call in wireAdmiralPty**

In `wireAdmiralPty` (line 214), add `admiralStateDetector?.scan(paneId, data)` inside the `ptyManager.onData` callback:

```typescript
const wireAdmiralPty = (paneId: string): void => {
  ptyManager.onData(paneId, (data) => {
    notificationDetector.scan(paneId, data);
    admiralStateDetector?.scan(paneId, data);
    const w = getWindow();
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId, data });
    }
  });
  ptyManager.onExit(paneId, (exitCode) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.PTY_EXIT, { paneId, exitCode });
    }
    eventBus.emit('pty-exit', { type: 'pty-exit', paneId, exitCode });
  });
  cwdPoller.startPolling(paneId, ptyManager.getPid(paneId) ?? 0);
};
```

Also add `setAdmiralPaneId` call inside the restart/reset handlers after wireAdmiralPty:

For `ADMIRAL_RESTART` handler (line 231-235):

```typescript
ipcMain.handle(IPC_CHANNELS.ADMIRAL_RESTART, async () => {
  const paneId = await admiralProcess.restart();
  admiralStateDetector?.setAdmiralPaneId(paneId);
  wireAdmiralPty(paneId);
  return paneId;
});
```

For `ADMIRAL_RESET` handler (line 236-240):

```typescript
ipcMain.handle(IPC_CHANNELS.ADMIRAL_RESET, async () => {
  const paneId = await admiralProcess.reset();
  admiralStateDetector?.setAdmiralPaneId(paneId);
  wireAdmiralPty(paneId);
  return paneId;
});
```

- [ ] **Step 4: Pass detector in registerIpcHandlers call**

In `src/main/index.ts`, update the `registerIpcHandlers` call (around line 338-357) to pass the detector as the last argument:

```typescript
registerIpcHandlers(
  ptyManager,
  layoutStore,
  eventBus,
  notificationDetector,
  notificationState,
  settingsStore,
  cwdPoller,
  gitService,
  () => mainWindow,
  sectorService,
  configService,
  crewService,
  missionService,
  admiralProcess,
  commsService,
  supplyRouteService,
  cargoService,
  retentionService,
  admiralStateDetector
);
```

- [ ] **Step 5: Verify build compiles**

Run: `cd /Users/khangnguyen/Development/fleet && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts
git commit -m "feat(starbase): wire AdmiralStateDetector into ipc-handlers wireAdmiralPty"
```

---

### Task 6: Add preload API listener

**Files:**

- Modify: `src/preload/index.ts:92-101`

- [ ] **Step 1: Import the payload type**

Add `AdmiralStateDetailPayload` to the imports from `../shared/ipc-api` (line 14-18):

```typescript
import type {
  PtyCreateRequest,
  PtyCreateResponse,
  PtyDataPayload,
  PtyInputPayload,
  PtyResizePayload,
  PtyExitPayload,
  PtyCwdPayload,
  LayoutSaveRequest,
  LayoutListResponse,
  NotificationPayload,
  PaneFocusedPayload,
  AgentStatePayload,
  GitStatusPayload,
  GitIsRepoPayload,
  AdmiralStateDetailPayload
} from '../shared/ipc-api';
```

- [ ] **Step 2: Add `onStateChanged` to the admiral namespace**

In `src/preload/index.ts`, inside the `admiral` object (after `onStatusChanged` around line 97-101), add:

```typescript
onStateDetail: (callback: (payload: AdmiralStateDetailPayload) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, payload: AdmiralStateDetailPayload) => callback(payload)
  ipcRenderer.on(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, handler)
  return () => { ipcRenderer.removeListener(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, handler) }
},
```

- [ ] **Step 3: Verify build compiles**

Run: `cd /Users/khangnguyen/Development/fleet && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(starbase): expose admiral.onStateDetail in preload API"
```

---

### Task 7: Update Zustand store

**Files:**

- Modify: `src/renderer/src/store/star-command-store.ts:27-69`

- [ ] **Step 1: Add `admiralStatusText` field and `setAdmiralState` action**

In `src/renderer/src/store/star-command-store.ts`:

Add to the `StarCommandStore` type (after `admiralAvatarState` on line 42):

```typescript
admiralStatusText: string;
```

Add to the Actions section (after `setAdmiralAvatarState` on line 50):

```typescript
setAdmiralState: (state: AdmiralAvatarState, statusText: string) => void;
```

Add to the store initial state (after `admiralAvatarState: 'standby'` on line 61):

```typescript
admiralStatusText: 'Standing by',
```

Add to the store actions (after `setAdmiralAvatarState` on line 68):

```typescript
setAdmiralState: (state, statusText) => set({ admiralAvatarState: state, admiralStatusText: statusText }),
```

- [ ] **Step 2: Verify build compiles**

Run: `cd /Users/khangnguyen/Development/fleet && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/star-command-store.ts
git commit -m "feat(starbase): add admiralStatusText and setAdmiralState to store"
```

---

### Task 8: Subscribe to state detail IPC in StarCommandTab

**Files:**

- Modify: `src/renderer/src/components/StarCommandTab.tsx:29-84`

- [ ] **Step 1: Subscribe to admiral state detail IPC**

In `src/renderer/src/components/StarCommandTab.tsx`:

Add `setAdmiralState` to the destructured store values (around line 30-40):

```typescript
const {
  admiralPaneId,
  admiralStatus,
  admiralError,
  setAdmiralPty,
  setCrewList,
  setMissionQueue,
  setSectors,
  setUnreadCount,
  admiralAvatarState,
  setAdmiralState
} = useStarCommandStore();
```

Add a new `useEffect` after the existing `onStatusChanged` subscription (after line 84):

```typescript
// Listen for detailed admiral state changes (thinking, speaking, etc.)
useEffect(() => {
  const cleanup = window.fleet.admiral.onStateDetail((data) => {
    setAdmiralState(data.state as 'standby' | 'thinking' | 'speaking' | 'alert', data.statusText);
  });
  return cleanup;
}, [setAdmiralState]);
```

- [ ] **Step 2: Verify build compiles**

Run: `cd /Users/khangnguyen/Development/fleet && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds. Note: TypeScript may report that `onStateDetail` doesn't exist on the fleet type — this is because the FleetApi type is derived from the preload. As long as the preload was updated in Task 6, this will work.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/StarCommandTab.tsx
git commit -m "feat(starbase): subscribe to admiral state detail IPC in StarCommandTab"
```

---

### Task 9: Display dynamic status text in AdmiralSidebar

**Files:**

- Modify: `src/renderer/src/components/star-command/AdmiralSidebar.tsx:30-71`

- [ ] **Step 1: Read `admiralStatusText` from store and display it**

In `src/renderer/src/components/star-command/AdmiralSidebar.tsx`:

Add `admiralStatusText` to the destructured store values (line 35):

```typescript
const { crewList, sectors, unreadCount, admiralStatus, admiralStatusText } = useStarCommandStore();
```

Replace the hardcoded status text block (lines 58-71) — the current `<div className="flex items-center gap-1.5 mt-1">` block that shows `admiralStatus`:

```typescript
<div className="flex items-center gap-1.5 mt-1">
  <span
    className={`w-2 h-2 rounded-full ${
      admiralStatus === 'running'
        ? 'bg-green-400'
        : admiralStatus === 'starting'
          ? 'bg-yellow-400 animate-pulse'
          : 'bg-red-500'
    }`}
  />
  <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
    {admiralStatus === 'running' ? admiralStatusText : admiralStatus}
  </span>
</div>
```

This shows the dynamic `admiralStatusText` (e.g. "Thinking...", "Executing: Bash") when running, and falls back to the lifecycle status ("starting", "stopped") otherwise.

- [ ] **Step 2: Verify build compiles**

Run: `cd /Users/khangnguyen/Development/fleet && npx electron-vite build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/star-command/AdmiralSidebar.tsx
git commit -m "feat(starbase): display dynamic admiral status text in sidebar"
```

---

### Task 10: Manual integration test

- [ ] **Step 1: Start the dev server**

Run: `cd /Users/khangnguyen/Development/fleet && npm run dev`

- [ ] **Step 2: Verify Admiral starts and avatar shows `standby`**

Open the Star Command tab. Admiral should start and the sidebar should show "Standing by" with the standby avatar image.

- [ ] **Step 3: Interact with Admiral and verify state transitions**

Type a message to the Admiral. Observe:

- Avatar changes to `thinking` when spinner appears
- Status text shows "Thinking..."
- Avatar changes to `speaking` when response streams
- Status text shows "Speaking"
- When Admiral runs a tool, status text shows "Executing: \<tool name\>"
- After ~2s of silence, avatar returns to `standby` with "Standing by"

- [ ] **Step 4: Verify permission prompt detection**

If a permission prompt appears (when not using `--dangerously-skip-permissions`), avatar should change to `alert` with "Awaiting permission". Note: Admiral runs with `--dangerously-skip-permissions` so this may not be testable in the default setup.

- [ ] **Step 5: Verify restart resets state**

Click Restart Admiral. Avatar should reset to `standby` during the restart process, then resume detection after startup.

- [ ] **Step 6: Final commit if any tweaks were needed**

```bash
git add -A
git commit -m "fix(starbase): integration test adjustments for admiral state detection"
```
