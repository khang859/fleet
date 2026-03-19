# Daemon Socket Robustness & Self-Healing

**Date:** 2026-03-19
**Status:** Approved

## Problem

Fleet's app depends on the Unix domain socket (`~/.fleet/fleet.sock`) for CLI-to-app communication. Currently, if the socket server crashes, stops accepting connections, or the app restarts, CLI clients fail with no recovery path. The system needs defense in depth: self-healing at the socket layer, health probing, intelligent CLI retry, and clean startup recovery.

## Approach: Layered Resilience

Each layer is independent, small, and testable. No architectural overhaul.

## Design

### 1. `ping` Health Check Command

Add a `ping` command to `SocketServer.dispatch()`. Returns `{ ok: true, data: { pong: true, uptime: <seconds> } }`.

- Built-in command with no service dependency — tracks `startTime` set during `start()`
- Sentinel uses it each sweep to verify the socket is processing requests
- CLI can use it as a pre-flight check
- Lightweight, no side effects, no state changes

**File:** `socket-server.ts` (~5 lines in `dispatch()`)

### 2. Socket Supervisor

New `SocketSupervisor` class that wraps `SocketServer` and provides automatic restart on failure.

**Responsibilities:**
- Owns the `SocketServer` instance and its lifecycle
- Monitors for server errors (`close`, `error` events on the `net.Server`)
- On failure: tears down the dead server, cleans up socket file, creates new `SocketServer`, calls `start()`
- Exponential backoff on restarts: 1s, 2s, 4s, capped at 30s (2x multiplier)
- Max restart attempts: 5 within a sliding 5-minute window (drop timestamps older than 5 minutes). After exceeding, emits `failed` and stops retrying
- **Concurrent restart guard:** `isRestarting` flag prevents Sentinel-triggered and error-triggered restarts from racing. If `restart()` is called while already restarting, the call is a no-op
- Emits events: `restarted` (successful restart), `failed` (permanently gave up)
- Proxies `state-change` events from inner `SocketServer`

**Integration in `index.ts`:**
```typescript
// Before:
socketServer = new SocketServer(SOCKET_PATH, { ...services })
socketServer.start().catch(...)

// After:
supervisor = new SocketSupervisor(SOCKET_PATH, { ...services })
supervisor.on('restarted', () => { /* notify UI, log to ships_log */ })
supervisor.on('failed', () => { /* notify UI critically, log to ships_log, send comms to admiral */ })
supervisor.start()
```

**On `failed` event:** `index.ts` handler logs to `ships_log`, sends a comms alert to admiral with `type: 'socket_failed'`, and shows a UI notification so the operator knows the socket layer gave up.

**Shutdown:** `shutdownAll()` in `index.ts` calls `supervisor.stop()` instead of `socketServer?.stop()`.

**`SocketServer` needs to expose its `net.Server`:** The Supervisor needs to attach `close`/`error` listeners to the inner `net.Server`. Add a `getServer()` accessor or have `SocketServer.start()` return the server, or emit error events from `SocketServer` itself.

**Relies on existing `SocketServer.stop()`** destroying all client connections before closing the server — this prevents EADDRINUSE on restart.

**File:** New `src/main/socket-supervisor.ts` (~100 lines)

### 3. Sentinel Socket Health Check

Extend existing Sentinel sweep loop with an 8th check that probes the socket.

- Sentinel gets a reference to `SocketSupervisor` via `SentinelDeps` (optional — only present when lock is acquired)
- Each sweep: connects to socket, sends `ping`, expects `pong` within 3 seconds (sweep interval is 10s, so 3s leaves comfortable headroom)
- Tracks consecutive failures via `consecutivePingFailures` counter. After 3 consecutive failed pings, calls `supervisor.restart()`
- Logs failures to `ships_log`, sends comms alert to admiral on restart (deduplicated via existing `lastAlertLevel` pattern)
- Counter resets to 0 on successful ping

**Separation of concerns:**
- Sentinel does detection (sweep loop, alerting infrastructure)
- Supervisor does restart (mechanics, backoff logic)
- If Supervisor is already restarting (due to `net.Server` error), Sentinel's `restart()` call is a no-op (guarded by `isRestarting`)

**Initialization order:** Supervisor must be constructed before Sentinel in `index.ts`. Currently `SocketServer` is created at line 219 and Sentinel at line 342 — this ordering is preserved.

**Note:** Sentinel only runs when lockfile is `acquired`. In read-only mode (second Fleet instance), the socket runs without Sentinel health checks. This is acceptable — the read-only instance doesn't own the socket.

**File:** `sentinel.ts` (~25 lines added, new optional dep in `SentinelDeps`)

### 4. CLI Retry with Wait-for-App

New `sendWithRetry()` method on `FleetCLI`, used by `runCLI()`.

**Behavior:**
- Socket file missing: poll every 500ms for up to 15 seconds. Prints `"Waiting for Fleet app to start..."` to stderr (once, not per poll)
- ECONNREFUSED: retry up to 4 times with exponential backoff (200ms, 400ms, 800ms, 1.6s — 2x multiplier). Prints brief retry status to stderr per attempt
- Other errors (timeout, invalid JSON, unknown command): fail immediately — not transient
- Busy server (connection succeeds but response is slow): handled by existing 60s timeout in `send()`, not by retry — retrying a long-running command would be harmful

**`send()` stays unchanged** for internal callers wanting raw single-shot behavior.

**Integration:** `runCLI()` changes `cli.send()` to `cli.sendWithRetry()`.

**File:** `fleet-cli.ts` (~40 lines added)

### 5. Startup Recovery Enhancements

- Before creating `SocketSupervisor`, check for stale `fleet.sock`. If it exists but no Fleet process owns it (check lockfile PID via `process.kill(pid, 0)`), remove it and log. Note: `SocketServer.start()` already does `unlinkSync` unconditionally — this outer check is for logging/diagnostics only (detecting unclean shutdown)
- After `supervisor.start()`, fire-and-forget a `ping` to verify socket health. This is **informational/logging only** — not a gate on app launch. If it fails, the supervisor's normal restart logic handles recovery
- Existing reconciliation (lost crew, worktree pruning, mission requeue) untouched

**Windows note:** On Windows, `SOCKET_PATH` is a named pipe (`\\.\pipe\fleet`). `unlinkSync` is a no-op on pipe paths. Socket cleanup is handled by the OS when the owning process dies. The supervisor's restart logic still works — it calls `stop()` then `start()`, which re-creates the pipe.

**File:** `index.ts` (~10 lines added)

### 6. Legacy `SocketApi` Cleanup

`SocketApi` is instantiated at `index.ts:55` but **never started** — `socketApi.start()` is never called. It's dead code. `shutdownAll()` calls `socketApi.stop()` which is a no-op on an unstarted server. This should be cleaned up as part of this work (remove the import, instantiation, and stop call) to avoid confusion.

**File:** `index.ts` (~3 lines removed)

## Touch Points Summary

| Component | File | Change Size |
|-----------|------|-------------|
| `ping` command | `socket-server.ts` | ~5 lines |
| Socket Supervisor | `socket-supervisor.ts` | New file, ~100 lines |
| Sentinel health check | `sentinel.ts` | ~25 lines |
| CLI retry | `fleet-cli.ts` | ~40 lines |
| Startup recovery + cleanup | `index.ts` | ~15 lines |

## What's NOT Changing

- No separate daemon process — recovery is within the Electron process
- No auto-launch of Electron from CLI
- Existing reconciliation, lockfile, and Sentinel sweeps 1-7 untouched
- `SocketServer` class internals unchanged (Supervisor wraps it)
- `socket-api.ts` file not modified (but its usage in `index.ts` is removed)
