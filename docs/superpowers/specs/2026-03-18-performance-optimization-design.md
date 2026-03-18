# Fleet Performance Optimization Design

**Date:** 2026-03-18
**Status:** Approved
**Target:** 5–15 concurrent agents, measurable improvements to CPU, memory, and startup time

---

## Overview

Fleet has six categories of performance issues identified through a full codebase audit and external research. This document covers the complete optimization design across all six pillars.

### Goals

- CPU: main process stays below noticeable overhead with 10–15 active agents
- Memory: stable heap over long sessions; no unbounded growth
- Startup: UI is interactive immediately; no blocking on git or PTY ops at launch

---

## Pillar 1: Kill Subprocess Spawning for CWD Detection

### Problem

`CwdPoller` spawns `execFile('lsof', ...)` every 5 seconds per pane on macOS. With 15 panes that is 3 subprocess spawns per second, each taking 100–500ms.

### Solution

Replace the `lsof` call with the `pid-cwd` npm package. It calls `proc_pidinfo` directly via a native C++ addon — the same syscall `lsof` uses internally, with no subprocess overhead. The Linux `/proc/{pid}/cwd` path is unchanged.

### Additional Fix

`cwdPoller.stopPolling(paneId)` is missing from the PTY exit handler, leaving zombie pollers running against dead PIDs. Add it to the `onExit` callback in `ipc-handlers.ts`.

### Changes

- `package.json`: add `pid-cwd`
- `cwd-poller.ts:60-88`: replace `execFile('lsof')` block with `await pidCwd(pid)` on macOS
- `ipc-handlers.ts`: call `cwdPoller.stopPolling(paneId)` inside the PTY exit handler

### Expected Gain

~3 subprocess spawns/second → 0. CWD reads become microsecond-level native syscalls.

---

## Pillar 2: Replace JsonlWatcher with Chokidar

### Problem

`JsonlWatcher` runs two overlapping polling mechanisms on every JSONL file:
1. `watchFile` with a 1s poll interval per file
2. A 1s `setInterval` that also calls `readNewLines` on all files

This is double the necessary work. `fs.watch` on macOS also misses events on atomic writes and produces duplicate events. Additionally, the `watchedFiles` Map never removes entries for deleted files — a memory leak that grows with every agent session.

### Solution

Rewrite `JsonlWatcher` using `chokidar` v4. Chokidar uses native FSEvents on macOS — sub-100ms latency, zero polling at idle, handles atomic writes via `awaitWriteFinish`.

### Design

- Watch `CLAUDE_PROJECTS_DIR` recursively for `*.jsonl` files via a single chokidar watcher
- `add` event: register the file, set offset to `stat.size` (pre-existing) or `0` (new)
- `change` event: call `readNewLines` for that specific file only
- `unlink` event: remove from `watchedFiles` Map (fixes memory leak)
- Remove: `dirWatchers`, `parentWatcher`, `scanTimer`, `watchFile` calls, `scanSubdirs`, `watchDir_sub` — all replaced by chokidar

### Changes

- `package.json`: add `chokidar` v4
- `jsonl-watcher.ts`: full rewrite; public interface unchanged (`start()`, `stop()`, `onRecord()`)

### Expected Gain

~30+ stat syscalls/second at idle → 0. Memory leak on deleted session files eliminated. Event latency drops from up to 1s → <100ms.

---

## Pillar 3: PTY IPC Batching + Backpressure

### Problem

Every `pty.onData` event fires an immediate `webContents.send(PTY_DATA)`. Claude Code emits hundreds of data events per second during tool use — each is a separate IPC serialization across the process boundary, causing renderer jank and CPU spikes.

Additionally, `onData` and `onExit` callbacks registered on node-pty instances are never cleaned up (the disposables returned by node-pty are not stored), accumulating orphaned listeners across the pane lifecycle.

### Solution

Add a per-pane output buffer in `PtyManager` that coalesces output and flushes on a 16ms shared timer. Add `pty.pause()`/`pty.resume()` backpressure when buffers overflow. Fix listener cleanup using node-pty disposables.

### Design

**Batching:**
- `onData` appends to a per-pane `string` buffer instead of calling the callback immediately
- A single shared `setInterval` at 16ms (not per-pane) flushes all dirty buffers in one pass
- If a pane's buffer exceeds 256 KB, flush immediately and call `pty.pause()`
- Renderer sends `PTY_DRAIN` IPC message after xterm processes a batch; main calls `pty.resume(paneId)`

**Listener cleanup:**
- node-pty's `onData` and `onExit` return `IDisposable` objects; store them on `PtyEntry` and call `.dispose()` inside `kill()`

### Changes

- `pty-manager.ts`: add output buffer + 16ms flush timer + pause/resume + `IDisposable` storage and cleanup on `PtyEntry`
- `ipc-handlers.ts`: add `PTY_DRAIN` IPC handler → `ptyManager.resume(paneId)`
- `preload/index.ts`: expose `ptyDrain(paneId)`
- `use-terminal.ts`: call `window.fleet.ptyDrain(paneId)` after xterm renders a batch

### Expected Gain

IPC message rate drops from hundreds/second to ~60/second per terminal. Eliminates renderer jank from IPC floods. Backpressure prevents memory accumulation behind slow renders.

---

## Pillar 4: Event-Driven Status Updates + SQLite WAL

### Problem

**Status polling:** Two unconditional timers push full DB reads to the renderer regardless of whether anything changed:
- `index.ts`: `setInterval` every 5s → full crew/mission/sector query → `webContents.send`
- `StarCommandTab.tsx`: `setInterval` every 5s → 3 IPC calls for the same data

**SQLite contention:** `StarbaseDB` opens without WAL mode. Under concurrent read/write workloads (Sentinel writes every 10s while status reads happen every 5s), the default journal mode serializes all access.

**Sentinel blocking `du`:** `getDiskUsage()` in `sentinel.ts` calls `execSync('du -sk ...')` — a synchronous subprocess that blocks the Node.js event loop while recursively scanning the worktree directory.

### Solution

Remove both polling timers. Emit a `starbase-changed` event from every service write path. Push a snapshot only when data changes. Enable WAL mode on the DB. Make disk usage scanning async.

### Design

**Event-driven updates:**
Add `starbase-changed` to the `EventBus` event map. Instrument write paths in each service — each service receives the shared `EventBus` instance via its existing constructor options object (e.g. `CrewServiceDeps`, `MissionServiceDeps` etc. — add an `eventBus: EventBus` field). Services emit `starbase-changed` after completing writes:
- `CrewService`: after `spawnCrew`, `updateCrewStatus`, `deleteCrew`
- `MissionService`: after `createMission`, `updateMission`, `completeMission`
- `SectorService`: after `addSector`, `updateSector`, `removeSector`
- `CommsService`: after `addMessage`
- `Sentinel`: after the comms rate-limit reset at `sentinel.ts:144-146` (the `if (this.sweepCount % 6 === 0)` block)

`index.ts` subscribes to `starbase-changed` and sends the same payload as today — just event-triggered instead of timer-triggered.

`StarCommandTab.tsx` removes its `setInterval` and relies on the existing `STARBASE_STATUS_UPDATE` IPC channel. **Note:** `StarCommandTab.tsx` is also modified by Pillar 6 (lazy Admiral start) — both changes land in the same file and must be applied together.

**SQLite WAL:**
Add three `PRAGMA` statements to `StarbaseDB.open()`: `journal_mode = WAL`, `synchronous = normal`, `temp_store = memory`. WAL mode enables concurrent readers during writes. `synchronous = normal` is safe with WAL. Note: WAL requires the companion `db.db-wal` file to be writable alongside the DB file — this is always the case in Electron's userData directory.

**Async `du`:**
Replace `execSync('du -sk ...')` in `sentinel.ts:getDiskUsage()` with `execFile` (async), storing the result in the existing `diskCacheBytes` field. The sentinel sweep already caches disk usage for 60s — the async result simply updates the cache when ready.

### Changes

- `event-bus.ts`: add `starbase-changed` to the event type map
- `starbase/crew-service.ts`, `mission-service.ts`, `sector-service.ts`, `comms-service.ts`: add `eventBus: EventBus` to each service's constructor options type; emit `starbase-changed` after writes
- `index.ts`: pass `eventBus` when constructing each service; remove 5s `setInterval`; add `eventBus.on('starbase-changed', ...)` handler
- `starbase/sentinel.ts`: emit `starbase-changed` at `sentinel.ts:144-146` after the `UPDATE crew SET comms_count_minute = 0` run; replace `execSync('du')` with async `execFile` in `getDiskUsage()`
- `starbase/db.ts`: add WAL pragmas in `open()`
- `StarCommandTab.tsx`: remove `setInterval`; rely on existing IPC push *(also modified by Pillar 6)*

### Expected Gain

DB reads drop from unconditional 3 reads/5s → only on actual state changes. Main thread unblocked from `du` scans. Concurrent DB reads no longer serialized behind sentinel writes.

---

## Pillar 5: Memory Fixes

### Problems

1. xterm scrollback set to 10,000 lines × N panes — up to 50–100MB for scroll buffers alone with 15 panes
2. `subAgents` Map in `AgentStateTracker` grows unbounded for long-lived sessions
3. `StationHub.tsx` runs a `requestAnimationFrame` loop at 60fps continuously even when the Star Command tab is not visible — it has no visibility awareness
4. `TerminalPane` spawns a git subprocess on every CWD change with no debounce — rapid `cd` chains fire bursts of git processes

### Solutions

**Scrollback:** Reduce `scrollback: 10000` → `scrollback: 3000` in `use-terminal.ts`. Note: `terminal.dispose()` is already correctly called at `use-terminal.ts:338` in the hook's cleanup function — no change needed there.

**Sub-agent eviction:** Cap `subAgents` Map at 100 entries per agent. When adding a new entry would exceed the cap, evict the entry with the oldest `lastActivity` timestamp. Sub-agents are display-only — evicting stale ones has no functional impact.

**StationHub RAF:** Add an `isVisible: boolean` prop to `StationHub`. When `isVisible` is `false`, cancel the `requestAnimationFrame` loop; when it becomes `true`, restart it. `StarCommandTab` passes `isVisible` based on whether the Star Command tab is the currently active tab (it already tracks this via its own active state). This approach is deterministic and does not rely on `document.visibilitychange` (which only distinguishes app-foreground vs. app-background, not tab-level visibility).

**Git check debounce:** Wrap `window.fleet.git.isRepo()` in a 500ms debounce in `TerminalPane`. Only the final CWD value in a rapid-navigation burst triggers a subprocess.

### Changes

- `use-terminal.ts`: `scrollback: 3000` (no change to dispose logic — already correct)
- `agent-state-tracker.ts`: cap `subAgents` at 100; evict by `lastActivity`
- `StationHub.tsx`: add `isVisible: boolean` prop; pause RAF when `false`, resume when `true`
- `StarCommandTab.tsx`: pass `isVisible` prop to `StationHub` *(also modified by Pillar 4 and Pillar 6)*
- `TerminalPane.tsx`: 500ms debounce on git status check

### Expected Gain

Renderer memory significantly reduced under load. No wasted GPU cycles when Star Command tab is not active. No subprocess bursts during directory navigation.

---

## Pillar 6: Unblock Startup

### Problems

1. `reconciliation.ts` calls `execSync` for `git worktree prune` per sector and `git push` per push-pending mission at app startup — blocks the event loop proportional to sector/mission count
2. `AdmiralProcess` auto-starts a full Claude Code PTY on every app launch, even if the user never opens Star Command

### Solutions

**Reconciliation async:** Replace all `execSync` git calls in `reconciliation.ts` with `await execFile(...)`. The function is already invoked with `.then()/.catch()` in `index.ts` — the fix is making the internals truly non-blocking so the event loop is released between git ops.

**Admiral lazy-start:** Remove `startAdmiralAndWire()` from the app startup path in `index.ts`. Add an idempotent IPC handler `admiral:ensure-started` — if Admiral is already running it returns the existing `paneId`, otherwise it calls `startAdmiralAndWire()` and returns the new `paneId`. `StarCommandTab` calls `window.fleet.admiral.ensureStarted()` on mount. **Note:** `StarCommandTab.tsx` is also modified by Pillars 4 and 5 — all three changes land in the same file and must be applied together.

### Changes

- `starbase/reconciliation.ts`: replace `execSync` with `await execFile` for all git subprocess calls
- `index.ts`: remove `startAdmiralAndWire()` from startup; add `ipcMain.handle('admiral:ensure-started', ...)`
- `preload/index.ts`: expose `admiral.ensureStarted()`
- `StarCommandTab.tsx`: call `window.fleet.admiral.ensureStarted()` on mount *(also modified by Pillars 4 and 5)*

### Expected Gain

App UI is interactive immediately on launch — no blocking on git ops. Admiral PTY (one full Claude Code process, ~200–400MB RAM) not spawned until actually needed.

---

## Files Changed Summary

| File | Pillar | Nature of Change |
|------|--------|-----------------|
| `package.json` | 1, 2 | Add `pid-cwd`, `chokidar` |
| `cwd-poller.ts` | 1 | Replace `lsof` with `pid-cwd` |
| `ipc-handlers.ts` | 1, 3 | Add `stopPolling` on PTY exit; add `PTY_DRAIN` handler |
| `jsonl-watcher.ts` | 2 | Full rewrite using chokidar |
| `pty-manager.ts` | 3 | Output buffer, 16ms flush, pause/resume, disposable cleanup |
| `preload/index.ts` | 3, 6 | Expose `ptyDrain`, `admiral.ensureStarted` |
| `use-terminal.ts` | 3, 5 | Call `ptyDrain`; scrollback 3000 |
| `starbase/db.ts` | 4 | WAL pragmas in `open()` |
| `event-bus.ts` | 4 | Add `starbase-changed` event type |
| `starbase/crew-service.ts` | 4 | Add `eventBus` to deps; emit `starbase-changed` after writes |
| `starbase/mission-service.ts` | 4 | Add `eventBus` to deps; emit `starbase-changed` after writes |
| `starbase/sector-service.ts` | 4 | Add `eventBus` to deps; emit `starbase-changed` after writes |
| `starbase/comms-service.ts` | 4 | Add `eventBus` to deps; emit `starbase-changed` after writes |
| `starbase/sentinel.ts` | 4 | Emit `starbase-changed` at sweep line 144; async `du` |
| `index.ts` | 4, 6 | Pass `eventBus` to services; remove 5s timer; add event handler; lazy Admiral |
| `StarCommandTab.tsx` | 4, 5, 6 | Remove `setInterval`; pass `isVisible` to StationHub; call `ensureStarted` on mount |
| `agent-state-tracker.ts` | 5 | Cap sub-agents at 100; evict by `lastActivity` |
| `StationHub.tsx` | 5 | Add `isVisible` prop; pause/resume RAF |
| `TerminalPane.tsx` | 5 | 500ms debounce on git status check |
| `starbase/reconciliation.ts` | 6 | Replace `execSync` with async `execFile` for git ops |

---

## Non-Goals

- Renderer-side React re-render optimization (not in scope)
- xterm.js WebGL renderer migration (Canvas addon is currently stable; WebGL is follow-up work)
- SharedArrayBuffer / MessageChannelMain streaming (16ms batching is sufficient for 5–15 agents)
- SQLite query optimization beyond WAL mode (queries are already fast; WAL alone addresses contention)
