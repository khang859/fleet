# Extensive Debug Logging — Design Spec

**Date**: 2026-03-27
**Goal**: Add dense, fine-grained debug logging across the entire Fleet app (main + renderer) to help diagnose hard-to-reproduce bugs like drag-and-drop ordering issues, state sync problems, and subtle UI glitches.

## Context

Fleet already has a Winston logger system in the main process with:
- Child logger factory (`createLogger(tag)`)
- Console transport (colorized in dev) + daily rotating file transport (`~/.fleet/logs/`)
- `debug` level in dev, `info` in production
- All main process files migrated from `console.*` to structured Winston logging

**What's missing**: The renderer (React/UI) has no structured logging at all. Hard-to-reproduce frontend bugs require step-by-step tracing of state changes, event handlers, and IPC calls — currently invisible.

## Architecture: Unified Logger with IPC Bridge

### Renderer Logger Module

New file: `src/renderer/src/logger.ts`

Mirrors the main process API:
```typescript
import { createLogger } from './logger';
const log = createLogger('sidebar:drag');
log.debug('drag start', { tabId, fromIndex });
```

Behavior by environment:
- **Dev mode**: Formats and outputs to `console.log/warn/error` (visible in DevTools) AND batches messages over IPC to main's Winston for file persistence
- **Production (packaged)**: All methods are no-op empty functions. Zero overhead, no IPC bridge initialized, no batch queue.

### IPC Plumbing

Three changes to wire renderer logs to main's Winston:

1. **New IPC channel** in `src/shared/ipc-channels.ts`:
   ```typescript
   LOG_BATCH: 'log:batch'
   ```

2. **Preload bridge** — new entry in `fleetApi` (`src/preload/index.ts`):
   ```typescript
   log: {
     batch: (entries: LogEntry[]) => ipcRenderer.send(IPC_CHANNELS.LOG_BATCH, entries)
   }
   ```
   Uses `send` (fire-and-forget), not `invoke` — logging must never block the renderer.

3. **Main process handler** in `src/main/ipc-handlers.ts`:
   Listens for `LOG_BATCH`, iterates entries, writes each through `logger.child({ tag })` at the appropriate level.

### Shared LogEntry Type

In `src/shared/ipc-api.ts`:
```typescript
export interface LogEntry {
  tag: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
  timestamp: string; // ISO 8601, captured at call site
}
```

### Batching Strategy

Renderer logs queue in memory and flush to main via IPC:
- Flush every **100ms** or when queue hits **50 entries**, whichever comes first
- Queue caps at **200 entries** — overflow drops oldest entries with a single warning
- Metadata objects are shallow-copied at call time (mutations after logging don't corrupt the log)
- Serialization (`JSON.stringify`) happens only at flush time, not per-call

### Lazy Metadata

For expensive debug metadata, support a lazy pattern:
```typescript
log.debug('state', () => ({ snapshot: getExpensiveState() }));
```
The function is only called if debug level is active (dev mode).

## Where to Add Debug Logs

### Renderer — New Logging (fine-grained tags)

| Tag | Location | What to log |
|-----|----------|-------------|
| `sidebar:tabs` | Sidebar tab components | Tab click, selection change, tab close, tab creation |
| `sidebar:dnd` | Drag-and-drop handlers | Drag start (tabId, fromIndex), drag over (targetIndex, position), drop (fromIndex, toIndex), reorder result, cancellation |
| `layout:state` | Layout store/components | Pane add/remove/split, workspace save/load, layout mutations, active pane changes |
| `terminal:lifecycle` | Terminal components | xterm mount/unmount/attach/detach, fit resize dimensions, data flow connect/disconnect |
| `store:notifications` | Notification store | Notification received, dismissed, state transitions |
| `store:settings` | Settings store | Setting read/write, store hydration |
| `store:cwd` | CWD store | CWD changes per pane, tracking updates |
| `ipc:calls` | Preload/IPC utility | Every IPC invoke/send with channel name and payload summary (truncated for large payloads) |

### Main Process — Enhance Existing Loggers

| Tag | Location | What to add |
|-----|----------|-------------|
| `pty:lifecycle` | pty-manager.ts | Spawn args, environment snapshot, exit code+signal, resize dimensions |
| `pty:data` | pty-manager.ts | Data flow direction, byte counts (NOT content), backpressure pause/resume events |
| `ipc:dispatch` | ipc-handlers.ts | Every incoming IPC with channel, args summary, response time |
| `layout:persistence` | layout-store.ts | Save/load operations, workspace structure, error details |
| `socket:messages` | socket-command-handler.ts | Inbound/outbound message types, routing decisions |
| `window:lifecycle` | index.ts | Window create/focus/blur/close, BrowserWindow state |

Each log call includes enough context to reconstruct what happened: IDs, indices, before/after values, timing.

## Production Safety

**Dev-only guarantee**:
- Renderer `createLogger` checks `import.meta.env.DEV` at module load time
- If not dev: returns stub object where all methods are `() => {}` — zero cost
- Main process: `app.isPackaged` defaults Winston to `info` level, filtering out `debug` calls

**Performance guardrails**:
- Batch queue overflow drops oldest entries (cap: 200)
- Shallow-copy metadata at call time
- No serialization in hot path — only at flush
- Lazy metadata functions only evaluated when debug level is active

**No new dependencies**: Renderer logger is pure TypeScript using existing preload bridge. Main side uses existing Winston instance.
