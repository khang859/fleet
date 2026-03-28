# CLI-Agnostic Attention Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CLI-agnostic activity state detection to Fleet's tab sidebar so users see working/idle/done/needs_me/error states for every PTY session without any CLI-specific protocol parsing.

**Architecture:** A new `ActivityTracker` in the main process watches PTY output timing, polls `pty.process` for foreground process name, and resolves a per-pane activity state from multiple signal layers. States flow via a new `activity-state-change` event through the existing EventBus → IPC → renderer notification store → TabItem badge pipeline. The existing `NotificationDetector` is expanded with generic permission patterns and OSC 133 parsing.

**Tech Stack:** Electron main process (Node.js), node-pty `IPty.process` getter, vitest for tests, React/Zustand for renderer state.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/types.ts` | Modify | Add `ActivityState` type |
| `src/shared/ipc-channels.ts` | Modify | Add `ACTIVITY_STATE` channel |
| `src/main/activity-tracker.ts` | Create | Per-pane silence timer, process polling, state resolution |
| `src/main/__tests__/activity-tracker.test.ts` | Create | Unit tests for ActivityTracker |
| `src/main/notification-detector.ts` | Modify | Expand permission patterns, add OSC 133 parsing |
| `src/main/__tests__/notification-detector.test.ts` | Modify | Tests for new patterns and OSC 133 |
| `src/main/event-bus.ts` | Modify | Add `activity-state-change` event type |
| `src/main/index.ts` | Modify | Wire ActivityTracker into PTY data flow and IPC |
| `src/main/pty-manager.ts` | Modify | Add `getProcessName()` method |
| `src/preload/index.ts` | Modify | Expose `activity.onStateChange` bridge |
| `src/shared/ipc-api.ts` | Modify | Add `ActivityStatePayload` type |
| `src/renderer/src/store/notification-store.ts` | Modify | Add activity state tracking, freshness timestamps |
| `src/renderer/src/components/TabItem.tsx` | Modify | Update badge config, add freshness display |
| `src/renderer/src/components/Sidebar.tsx` | Modify | Add off-screen badge summary |
| `src/renderer/src/hooks/use-notifications.ts` | Modify | Subscribe to activity state changes |

---

### Task 1: Add ActivityState Type and IPC Channel

**Files:**
- Modify: `src/shared/types.ts:40`
- Modify: `src/shared/ipc-channels.ts:101`
- Modify: `src/shared/ipc-api.ts:57`

- [ ] **Step 1: Add ActivityState type to shared/types.ts**

Add after line 40 (after the `NotificationLevel` type):

```typescript
export type ActivityState = 'working' | 'idle' | 'done' | 'needs_me' | 'error';
```

- [ ] **Step 2: Add IPC channel to shared/ipc-channels.ts**

Add before the closing `} as const;` on line 102:

```typescript
  ACTIVITY_STATE: 'activity:state',
```

- [ ] **Step 3: Add ActivityStatePayload to shared/ipc-api.ts**

Add after the `NotificationPayload` type alias (line 57):

```typescript
export type ActivityStatePayload = {
  paneId: string;
  state: import('./types').ActivityState;
  lastOutputAt: number;
  timestamp: number;
};
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/ipc-channels.ts src/shared/ipc-api.ts
git commit -m "feat(attention): add ActivityState type and IPC channel"
```

---

### Task 2: Add getProcessName to PtyManager

**Files:**
- Modify: `src/main/pty-manager.ts:178-179`

- [ ] **Step 1: Add getProcessName method to PtyManager**

Add after the `getPid` method (after line 180):

```typescript
  /** Returns the current foreground process name for a PTY (e.g. "zsh", "node", "claude"). */
  getProcessName(paneId: string): string | undefined {
    return this.ptys.get(paneId)?.process.process;
  }
```

Note: `entry.process` is the `IPty` instance, and `IPty.process` is the getter that returns the foreground process name string.

- [ ] **Step 2: Commit**

```bash
git add src/main/pty-manager.ts
git commit -m "feat(pty): add getProcessName for foreground process detection"
```

---

### Task 3: Add activity-state-change Event to EventBus

**Files:**
- Modify: `src/main/event-bus.ts:4-16`

- [ ] **Step 1: Add event type to FleetEvent union**

Add a new union member to the `FleetEvent` type after the `pty-exit` member (line 8):

```typescript
  | { type: 'activity-state-change'; paneId: string; state: import('../shared/types').ActivityState; lastOutputAt: number; timestamp: number }
```

- [ ] **Step 2: Commit**

```bash
git add src/main/event-bus.ts
git commit -m "feat(events): add activity-state-change event type"
```

---

### Task 4: Create ActivityTracker with Tests (TDD)

**Files:**
- Create: `src/main/__tests__/activity-tracker.test.ts`
- Create: `src/main/activity-tracker.ts`

- [ ] **Step 1: Write failing tests for ActivityTracker**

Create `src/main/__tests__/activity-tracker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityTracker } from '../activity-tracker';
import { EventBus } from '../event-bus';

describe('ActivityTracker', () => {
  let eventBus: EventBus;
  let tracker: ActivityTracker;
  let getProcessName: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    getProcessName = vi.fn().mockReturnValue('zsh');
    tracker = new ActivityTracker(eventBus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 2000,
      getProcessName,
    });
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('transitions to working on data received', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'activity-state-change',
        paneId: 'pane-1',
        state: 'working',
      })
    );
  });

  it('transitions to idle after silence threshold', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    callback.mockClear();

    vi.advanceTimersByTime(5000);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'idle',
      })
    );
  });

  it('resets silence timer on new data', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    vi.advanceTimersByTime(4000);
    tracker.onData('pane-1'); // reset timer
    callback.mockClear();

    vi.advanceTimersByTime(4000); // 4s after reset, still under 5s
    expect(callback).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'idle' })
    );

    vi.advanceTimersByTime(1000); // now 5s after reset
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'idle' })
    );
  });

  it('transitions to done on process exit code 0', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onExit('pane-1', 0);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'done',
      })
    );
  });

  it('transitions to error on process exit code != 0', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onExit('pane-1', 1);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'error',
      })
    );
  });

  it('transitions to needs_me on permission signal', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onNeedsMe('pane-1');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'needs_me',
      })
    );
  });

  it('needs_me overrides working state', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    callback.mockClear();

    tracker.onNeedsMe('pane-1');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'needs_me',
      })
    );
  });

  it('does not emit duplicate states', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    tracker.onData('pane-1');
    tracker.onData('pane-1');

    // Should only emit once for 'working' — subsequent data events
    // in the same state are deduped
    const workingCalls = callback.mock.calls.filter(
      (c) => c[0].state === 'working'
    );
    expect(workingCalls).toHaveLength(1);
  });

  it('cleans up pane on untrack', () => {
    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    tracker.untrackPane('pane-1');

    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    // Should not emit after untrack
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('uses process polling to detect idle at shell prompt', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1'); // state = working
    callback.mockClear();

    // Simulate silence + shell at prompt
    getProcessName.mockReturnValue('zsh');
    vi.advanceTimersByTime(2000); // process poll fires

    // Process poll alone doesn't override — but combined with silence at 5s:
    vi.advanceTimersByTime(3000); // total 5s silence

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'idle' })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/activity-tracker.test.ts`
Expected: FAIL — `Cannot find module '../activity-tracker'`

- [ ] **Step 3: Write ActivityTracker implementation**

Create `src/main/activity-tracker.ts`:

```typescript
import type { EventBus } from './event-bus';
import type { ActivityState } from '../shared/types';
import { createLogger } from './logger';

const log = createLogger('activity-tracker');

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', 'pwsh', 'powershell', 'cmd.exe']);

type PaneState = {
  state: ActivityState;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  lastOutputAt: number;
  exited: boolean;
};

export type ActivityTrackerOptions = {
  silenceThresholdMs: number;
  processPollingIntervalMs: number;
  getProcessName: (paneId: string) => string | undefined;
};

export class ActivityTracker {
  private panes = new Map<string, PaneState>();
  private eventBus: EventBus;
  private opts: ActivityTrackerOptions;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(eventBus: EventBus, opts: ActivityTrackerOptions) {
    this.eventBus = eventBus;
    this.opts = opts;

    this.pollTimer = setInterval(() => this.pollProcesses(), opts.processPollingIntervalMs);
  }

  trackPane(paneId: string): void {
    if (this.panes.has(paneId)) return;
    this.panes.set(paneId, {
      state: 'idle',
      silenceTimer: null,
      lastOutputAt: 0,
      exited: false,
    });
  }

  untrackPane(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (pane?.silenceTimer) clearTimeout(pane.silenceTimer);
    this.panes.delete(paneId);
  }

  onData(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.exited) return;

    pane.lastOutputAt = Date.now();

    // Reset silence timer
    if (pane.silenceTimer) clearTimeout(pane.silenceTimer);
    pane.silenceTimer = setTimeout(() => this.onSilence(paneId), this.opts.silenceThresholdMs);

    this.setState(paneId, 'working');
  }

  onNeedsMe(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    this.setState(paneId, 'needs_me');
  }

  onExit(paneId: string, exitCode: number): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    pane.exited = true;
    if (pane.silenceTimer) {
      clearTimeout(pane.silenceTimer);
      pane.silenceTimer = null;
    }

    this.setState(paneId, exitCode === 0 ? 'done' : 'error');
  }

  getState(paneId: string): ActivityState | undefined {
    return this.panes.get(paneId)?.state;
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [, pane] of this.panes) {
      if (pane.silenceTimer) clearTimeout(pane.silenceTimer);
    }
    this.panes.clear();
  }

  private onSilence(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.exited) return;

    // Don't override needs_me with idle
    if (pane.state === 'needs_me') return;

    this.setState(paneId, 'idle');
  }

  private pollProcesses(): void {
    for (const [paneId, pane] of this.panes) {
      if (pane.exited) continue;

      const processName = this.opts.getProcessName(paneId);
      if (!processName) continue;

      const isAtShell = SHELL_NAMES.has(processName);

      // If shell is at prompt and we're currently working, the command finished.
      // Let the silence timer handle the transition — process polling just
      // provides a confirming signal, not an override.
      if (isAtShell && pane.state === 'working') {
        log.debug('process poll: shell at prompt while working', { paneId, processName });
      }
    }
  }

  private setState(paneId: string, newState: ActivityState): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    // Dedup — don't emit if state hasn't changed
    if (pane.state === newState) return;

    // State priority: needs_me can only be cleared by new data or exit
    if (pane.state === 'needs_me' && newState === 'idle') return;

    const prevState = pane.state;
    pane.state = newState;

    log.debug('state change', { paneId, from: prevState, to: newState });

    this.eventBus.emit('activity-state-change', {
      type: 'activity-state-change',
      paneId,
      state: newState,
      lastOutputAt: pane.lastOutputAt,
      timestamp: Date.now(),
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/activity-tracker.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/activity-tracker.ts src/main/__tests__/activity-tracker.test.ts
git commit -m "feat(attention): add ActivityTracker with silence timer and process polling"
```

---

### Task 5: Expand NotificationDetector with Generic Patterns and OSC 133

**Files:**
- Modify: `src/main/notification-detector.ts`
- Modify: `src/main/__tests__/notification-detector.test.ts`

- [ ] **Step 1: Write failing tests for new patterns**

Add these tests to `src/main/__tests__/notification-detector.test.ts`:

```typescript
  it('detects generic [Y/n] permission prompt', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'Overwrite file? [Y/n] ');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'permission' })
    );
  });

  it('detects "Are you sure?" prompt', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'Are you sure? ');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'permission' })
    );
  });

  it('detects "Continue?" prompt', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'Continue? ');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'permission' })
    );
  });

  it('detects OSC 133;D command completion with exit code 0', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', '\x1b]133;D;0\x1b\\');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'subtle' })
    );
  });

  it('detects OSC 133;D command completion with non-zero exit code', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', '\x1b]133;D;1\x1b\\');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'error' })
    );
  });

  it('detects OSC 133;C command execution start', () => {
    const callback = vi.fn();
    eventBus.on('command-started', callback);

    detector.scan('pane-1', '\x1b]133;C\x1b\\');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1' })
    );
  });
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run src/main/__tests__/notification-detector.test.ts`
Expected: New tests FAIL, existing tests still pass.

- [ ] **Step 3: Expand PERMISSION_PATTERNS in notification-detector.ts**

Replace the `PERMISSION_PATTERNS` array (lines 5-10) with:

```typescript
const PERMISSION_PATTERNS = [
  // Claude Code patterns
  /Do you want to (?:allow|proceed|continue)/i,
  /\(y\/n\)\s*$/,
  /Allow this action\?/i,
  /Press Enter to confirm/i,
  // Generic CLI patterns
  /\[Y\/n\]\s*$/,
  /\[yes\/no\]\s*$/i,
  /Continue\?\s*$/i,
  /Approve\?\s*$/i,
  /Press Enter to continue/i,
  /Are you sure\?/i,
  /\(yes\/no\)\s*$/i,
];
```

- [ ] **Step 4: Add OSC 133 parsing**

Add the `command-started` event type to `event-bus.ts` — add to the `FleetEvent` union:

```typescript
  | { type: 'command-started'; paneId: string; timestamp: number }
```

Then add the OSC 133 regex and check method to `notification-detector.ts`. Add after the `OSC7_RE` constant (line 14):

```typescript
// OSC 133;C — command execution started (FinalTerm/shell integration)
// eslint-disable-next-line no-control-regex
const OSC133C_RE = /\x1b\]133;C\x1b\\/;

// OSC 133;D[;exitcode] — command finished (FinalTerm/shell integration)
// eslint-disable-next-line no-control-regex
const OSC133D_RE = /\x1b\]133;D(?:;(\d+))?\x1b\\/;
```

Add the check methods to the `NotificationDetector` class:

```typescript
  private checkOSC133(paneId: string, data: string): void {
    if (OSC133C_RE.test(data)) {
      this.eventBus.emit('command-started', {
        type: 'command-started',
        paneId,
        timestamp: Date.now(),
      });
    }

    const dMatch = OSC133D_RE.exec(data);
    if (dMatch) {
      const exitCode = dMatch[1] ? parseInt(dMatch[1], 10) : 0;
      this.emitNotification(paneId, exitCode === 0 ? 'subtle' : 'error');
    }
  }
```

Call `this.checkOSC133(paneId, data)` in the `scan` method.

- [ ] **Step 5: Update the comment on line 4**

Replace the Claude-specific comment:

```typescript
// Permission prompt patterns for CLI tools (generic, not CLI-specific)
```

- [ ] **Step 6: Run all notification-detector tests**

Run: `npx vitest run src/main/__tests__/notification-detector.test.ts`
Expected: All tests PASS (old and new).

- [ ] **Step 7: Commit**

```bash
git add src/main/notification-detector.ts src/main/__tests__/notification-detector.test.ts src/main/event-bus.ts
git commit -m "feat(attention): expand permission patterns and add OSC 133 parsing"
```

---

### Task 6: Wire ActivityTracker into Main Process

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Import and instantiate ActivityTracker**

Add import at the top of `src/main/index.ts` (after line 10):

```typescript
import { ActivityTracker } from './activity-tracker';
```

Add instantiation after the `notificationState` line (after line 48):

```typescript
const activityTracker = new ActivityTracker(eventBus, {
  silenceThresholdMs: 5000,
  processPollingIntervalMs: 2000,
  getProcessName: (paneId) => ptyManager.getProcessName(paneId),
});
```

- [ ] **Step 2: Hook into PTY lifecycle events**

Find where `pane-created` events are emitted (or where PTYs are created via IPC handlers). Add `activityTracker.trackPane(paneId)` after PTY creation.

Find the existing `eventBus.on('pane-closed', ...)` handlers. Add:

```typescript
eventBus.on('pane-closed', (event) => {
  activityTracker.untrackPane(event.paneId);
});
```

- [ ] **Step 3: Feed PTY data to ActivityTracker**

In the PTY data handler setup (where `notificationDetector.scan()` is called, around line 592 in the current code), add:

```typescript
activityTracker.onData(paneId);
```

This goes alongside the existing `notificationDetector.scan(paneId, data)` call.

- [ ] **Step 4: Connect notification events to ActivityTracker**

The existing `eventBus.on('notification', ...)` handler (around line 653) already fires for permission prompts. Add a listener that bridges notification → activity:

```typescript
eventBus.on('notification', (event) => {
  if (event.level === 'permission') {
    activityTracker.onNeedsMe(event.paneId);
  }
});
```

- [ ] **Step 5: Connect PTY exit to ActivityTracker**

The existing `eventBus.on('pty-exit', ...)` handler (line 666) already fires. Add:

```typescript
eventBus.on('pty-exit', (event) => {
  activityTracker.onExit(event.paneId, event.exitCode);
});
```

- [ ] **Step 6: Forward activity-state-change to renderer via IPC**

Add a listener that sends activity state changes to the renderer window:

```typescript
eventBus.on('activity-state-change', (event) => {
  const w = mainWindow;
  if (w && !w.isDestroyed()) {
    w.webContents.send(IPC_CHANNELS.ACTIVITY_STATE, {
      paneId: event.paneId,
      state: event.state,
      lastOutputAt: event.lastOutputAt,
      timestamp: event.timestamp,
    });
  }
});
```

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(attention): wire ActivityTracker into PTY data flow and IPC"
```

---

### Task 7: Add Preload Bridge for Activity State

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/shared/ipc-api.ts` (already done in Task 1)

- [ ] **Step 1: Add activity bridge to preload**

In `src/preload/index.ts`, add the import for `ActivityStatePayload` to the import block (line 14 area):

```typescript
import type { ActivityStatePayload } from '../shared/ipc-api';
```

Add a new `activity` namespace in the `fleetApi` object, after the `notifications` block (after line 136):

```typescript
  activity: {
    onStateChange: (callback: (payload: ActivityStatePayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ACTIVITY_STATE, callback),
  },
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(attention): expose activity state change bridge in preload"
```

---

### Task 8: Update Renderer Notification Store

**Files:**
- Modify: `src/renderer/src/store/notification-store.ts`

- [ ] **Step 1: Add activity state tracking to the store**

Replace the entire `notification-store.ts` with:

```typescript
import { create } from 'zustand';
import type { NotificationLevel, ActivityState } from '../../../shared/types';
import { createLogger } from '../logger';

const log = createLogger('store:notifications');

type NotificationRecord = {
  paneId: string;
  level: NotificationLevel;
  timestamp: number;
};

type ActivityRecord = {
  paneId: string;
  state: ActivityState;
  lastOutputAt: number;
  timestamp: number;
};

type NotificationStore = {
  notifications: Map<string, NotificationRecord>;
  activities: Map<string, ActivityRecord>;
  setNotification: (record: NotificationRecord) => void;
  setActivity: (record: ActivityRecord) => void;
  clearPane: (paneId: string) => void;
  getTabBadge: (paneIds: string[]) => NotificationLevel | null;
  getActivity: (paneId: string) => ActivityRecord | undefined;
  getTabActivity: (paneIds: string[]) => ActivityRecord | undefined;
};

const PRIORITY: Record<NotificationLevel, number> = {
  permission: 3,
  error: 2,
  info: 1,
  subtle: 0
};

/** Map activity states to notification badge levels for the tab sidebar. */
function activityToBadge(state: ActivityState): NotificationLevel | null {
  switch (state) {
    case 'needs_me': return 'permission';
    case 'error': return 'error';
    case 'done': return 'info';
    case 'working': return 'subtle';
    case 'idle': return null;
  }
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: new Map(),
  activities: new Map(),

  setNotification: (record) => {
    log.debug('setNotification', { paneId: record.paneId, level: record.level });
    set((state) => {
      const next = new Map(state.notifications);
      const existing = next.get(record.paneId);
      if (!existing || PRIORITY[record.level] >= PRIORITY[existing.level]) {
        next.set(record.paneId, record);
      }
      return { notifications: next };
    });
  },

  setActivity: (record) => {
    log.debug('setActivity', { paneId: record.paneId, state: record.state });
    set((state) => {
      const next = new Map(state.activities);
      next.set(record.paneId, record);
      return { activities: next };
    });
  },

  clearPane: (paneId) => {
    log.debug('clearPane', { paneId });
    set((state) => {
      const nextNotif = new Map(state.notifications);
      const nextActivity = new Map(state.activities);
      nextNotif.delete(paneId);
      nextActivity.delete(paneId);
      return { notifications: nextNotif, activities: nextActivity };
    });
  },

  getTabBadge: (paneIds) => {
    const { notifications, activities } = get();
    let highest: NotificationLevel | null = null;
    let highestPriority = -1;

    for (const paneId of paneIds) {
      // Check activity-based badges first
      const activity = activities.get(paneId);
      if (activity) {
        const badge = activityToBadge(activity.state);
        if (badge && PRIORITY[badge] > highestPriority) {
          highest = badge;
          highestPriority = PRIORITY[badge];
        }
      }

      // Check notification-based badges (existing behavior)
      const record = notifications.get(paneId);
      if (record && PRIORITY[record.level] > highestPriority) {
        highest = record.level;
        highestPriority = PRIORITY[record.level];
      }
    }
    return highest;
  },

  getActivity: (paneId) => {
    return get().activities.get(paneId);
  },

  getTabActivity: (paneIds) => {
    const { activities } = get();
    // Return the most recent activity across all panes in the tab
    let latest: ActivityRecord | undefined;
    for (const paneId of paneIds) {
      const record = activities.get(paneId);
      if (record && (!latest || record.timestamp > latest.timestamp)) {
        latest = record;
      }
    }
    return latest;
  },
}));
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/notification-store.ts
git commit -m "feat(attention): add activity state tracking to notification store"
```

---

### Task 9: Subscribe to Activity State in useNotifications Hook

**Files:**
- Modify: `src/renderer/src/hooks/use-notifications.ts`

- [ ] **Step 1: Add activity state subscription**

Add a second `useEffect` to subscribe to the activity state IPC channel. Update the file:

```typescript
import { useEffect, useRef } from 'react';
import { useNotificationStore } from '../store/notification-store';

export function useNotifications(): void {
  const { setNotification, setActivity } = useNotificationStore();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Create audio element for notification chime.
    // Generate a minimal WAV beep as a data URI (440Hz, 100ms)
    const audio = new Audio();
    const sampleRate = 8000;
    const duration = 0.1;
    const samples = sampleRate * duration;
    const buffer = new ArrayBuffer(44 + samples);
    const view = new DataView(buffer);
    const writeString = (offset: number, str: string): void => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeString(36, 'data');
    view.setUint32(40, samples, true);
    for (let i = 0; i < samples; i++) {
      view.setUint8(44 + i, 128 + 64 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    }
    const blob = new Blob([buffer], { type: 'audio/wav' });
    audio.src = URL.createObjectURL(blob);
    audio.volume = 0.3;
    audioRef.current = audio;
  }, []);

  // Subscribe to notification events (existing)
  useEffect(() => {
    const cleanup = window.fleet.notifications.onNotification((payload) => {
      setNotification({
        paneId: payload.paneId,
        level: payload.level,
        timestamp: payload.timestamp
      });

      // Play sound for permission notifications (default behavior)
      if (payload.level === 'permission' && audioRef.current) {
        audioRef.current.play().catch(() => {
          // Audio play may be blocked by browser autoplay policy — ignore
        });
      }
    });
    return () => {
      cleanup();
    };
  }, [setNotification]);

  // Subscribe to activity state changes (new)
  useEffect(() => {
    const cleanup = window.fleet.activity.onStateChange((payload) => {
      setActivity({
        paneId: payload.paneId,
        state: payload.state,
        lastOutputAt: payload.lastOutputAt,
        timestamp: payload.timestamp,
      });

      // Play sound for needs_me state (agent blocked on permission)
      if (payload.state === 'needs_me' && audioRef.current) {
        audioRef.current.play().catch(() => {
          // Audio play may be blocked by browser autoplay policy — ignore
        });
      }
    });
    return () => {
      cleanup();
    };
  }, [setActivity]);
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/use-notifications.ts
git commit -m "feat(attention): subscribe to activity state changes in useNotifications"
```

---

### Task 10: Update TabItem Badge Config and Add Freshness Display

**Files:**
- Modify: `src/renderer/src/components/TabItem.tsx`

- [ ] **Step 1: Update BADGE_CONFIG**

The existing `BADGE_CONFIG` (lines 50-58) already covers `permission`, `error`, `info`, `subtle`. These map correctly to our activity states via `activityToBadge()`:

- `needs_me` → `permission` (amber, `?`, pulse)
- `error` → `error` (red, `!`)
- `done` → `info` (blue)
- `working` → `subtle` (small green dot)

The config is already correct. No changes needed to the badge visuals.

- [ ] **Step 2: Add freshness timestamp display**

Import `useNotificationStore` and add freshness to the subtitle. Add import at top:

```typescript
import { useNotificationStore } from '../store/notification-store';
```

Add a helper function before the `TabItem` component:

```typescript
function formatFreshness(lastOutputAt: number, state: string): string | null {
  if (state === 'working' || !lastOutputAt) return null;
  const elapsed = Date.now() - lastOutputAt;
  if (elapsed < 10_000) return null; // Don't show for <10s
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  if (minutes > 0) {
    const timeStr = `${minutes}m ago`;
    return state === 'needs_me' ? `${minutes}m waiting` : timeStr;
  }
  const timeStr = `${seconds}s ago`;
  return state === 'needs_me' ? `${seconds}s waiting` : timeStr;
}
```

Inside the `TabItem` component, add a subscription to the activity store. After the `liveCwd` line (line 82):

```typescript
  const activity = useNotificationStore((s) =>
    drivingPaneId ? s.getActivity(drivingPaneId) : undefined
  );
```

Add a state variable for freshness that updates periodically:

```typescript
  const [freshness, setFreshness] = useState<string | null>(null);

  useEffect(() => {
    if (!activity || activity.state === 'working') {
      setFreshness(null);
      return;
    }
    // Update freshness every 10s
    const update = (): void => setFreshness(formatFreshness(activity.lastOutputAt, activity.state));
    update();
    const interval = setInterval(update, 10_000);
    return () => clearInterval(interval);
  }, [activity]);
```

Update the subtitle display (around line 213) to include freshness:

```typescript
<div className="truncate text-xs leading-tight text-neutral-500">
  {freshness ? (
    <span className={activity?.state === 'needs_me' ? 'text-amber-400' : ''}>
      {freshness}
    </span>
  ) : (
    shortenPath(cwd)
  )}
</div>
```

- [ ] **Step 3: Add prefers-reduced-motion support**

The existing `animate-pulse` class in `BADGE_CONFIG` is a Tailwind utility. Add a CSS media query override. In `src/renderer/src/assets/main.css` (or wherever global styles live), add:

```css
@media (prefers-reduced-motion: reduce) {
  .animate-pulse {
    animation: none !important;
  }
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TabItem.tsx src/renderer/src/assets/main.css
git commit -m "feat(attention): add freshness timestamps and reduced-motion support to tabs"
```

---

### Task 11: Add Off-Screen Badge Summary to Sidebar

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Find the tab list scroll container in Sidebar.tsx**

Search for the scrollable container that holds the tab list. Look for `overflow-y-auto` or similar scroll classes in the Sidebar component.

- [ ] **Step 2: Add off-screen badge summary component**

Create a small inline component above the Sidebar export:

```typescript
function OffScreenBadgeSummary({
  direction,
  count,
  label,
}: {
  direction: 'above' | 'below';
  count: number;
  label: string;
}): React.JSX.Element | null {
  if (count === 0) return null;
  const arrow = direction === 'above' ? '\u2191' : '\u2193';
  return (
    <div className="px-3 py-0.5 text-[10px] text-neutral-500 text-center">
      {arrow} {count} {label}
    </div>
  );
}
```

- [ ] **Step 3: Track which tabs are off-screen**

Use an `IntersectionObserver` on each tab item to detect visibility. In the Sidebar component where tabs are rendered, add:

```typescript
const [offScreenCounts, setOffScreenCounts] = useState({ above: 0, below: 0 });
const tabListRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  const container = tabListRef.current;
  if (!container) return;

  const observer = new IntersectionObserver(
    () => {
      // Count tabs with badges that are above/below the visible area
      const tabElements = container.querySelectorAll('[data-tab-id]');
      let above = 0;
      let below = 0;
      const containerRect = container.getBoundingClientRect();

      tabElements.forEach((el) => {
        const tabId = el.getAttribute('data-tab-id');
        if (!tabId) return;
        // Check if this tab has a badge (find associated tab data)
        const rect = el.getBoundingClientRect();
        const hasBadge = el.querySelector('[aria-label*="notification"]');
        if (!hasBadge) return;
        if (rect.bottom < containerRect.top) above++;
        else if (rect.top > containerRect.bottom) below++;
      });

      setOffScreenCounts({ above, below });
    },
    { root: container, threshold: 0 }
  );

  const tabElements = container.querySelectorAll('[data-tab-id]');
  tabElements.forEach((el) => observer.observe(el));

  return () => observer.disconnect();
}, [/* re-run when tabs change */]);
```

- [ ] **Step 4: Render the summaries**

Place `OffScreenBadgeSummary` above and below the scrollable tab list:

```typescript
<OffScreenBadgeSummary direction="above" count={offScreenCounts.above} label="need attention" />
<div ref={tabListRef} className="flex-1 overflow-y-auto ...">
  {/* existing tab rendering */}
</div>
<OffScreenBadgeSummary direction="below" count={offScreenCounts.below} label="need attention" />
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(attention): add off-screen badge summary to sidebar"
```

---

### Task 12: Wire Up PTY Create to ActivityTracker in IPC Handlers

**Files:**
- Modify: `src/main/ipc-handlers.ts` or `src/main/index.ts` (wherever PTY creation is handled)

- [ ] **Step 1: Find where PTY create IPC is handled**

Search for `IPC_CHANNELS.PTY_CREATE` in `src/main/index.ts` or `src/main/ipc-handlers.ts` to find where PTYs are created.

- [ ] **Step 2: Add trackPane call after PTY creation**

After a successful `ptyManager.create()` call, add:

```typescript
activityTracker.trackPane(paneId);
```

Also wire the `onData` callback to feed the ActivityTracker. In the PTY data handler (where data flows from pty to renderer), ensure `activityTracker.onData(paneId)` is called for every PTY, not just the Admiral PTY.

- [ ] **Step 3: Wire PTY exit to ActivityTracker for all PTYs**

Ensure the `pty-exit` → `activityTracker.onExit()` wiring (from Task 6) covers all PTYs, not just those with explicit `onExit` listeners.

- [ ] **Step 4: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts
git commit -m "feat(attention): wire PTY creation to ActivityTracker for all terminal panes"
```

---

### Task 13: End-to-End Verification

**Files:** None (manual testing)

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Manual smoke test**

Launch Fleet in dev mode (`npm run dev`). Open 3 terminal tabs:
1. Run `sleep 10` in tab 1 — should show working (subtle green dot), then idle after it finishes
2. Run a command that prompts for input (e.g., `rm -i somefile`) in tab 2 — should show needs_me (amber dot with ?)
3. Run `exit 1` in tab 3 — should show error (red dot with !)

Switch between tabs and verify badges clear on focus.

- [ ] **Step 6: Commit any fixes from smoke testing**

```bash
git add -A
git commit -m "fix(attention): address issues found during smoke testing"
```
