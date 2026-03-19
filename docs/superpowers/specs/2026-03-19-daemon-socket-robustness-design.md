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

- Built-in command with no service dependency
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
- Exponential backoff on restarts: 1s, 2s, 4s, capped at 30s
- Max restart attempts: 5 within a 5-minute window — after that, gives up and logs critical error
- Emits events: `restarted`, `failed` (permanently gave up)
- Proxies `state-change` events from inner `SocketServer`

**Integration in `index.ts`:**
```typescript
// Before:
socketServer = new SocketServer(SOCKET_PATH, { ...services })
socketServer.start().catch(...)

// After:
supervisor = new SocketSupervisor(SOCKET_PATH, { ...services })
supervisor.on('restarted', () => { /* notify UI */ })
supervisor.on('failed', () => { /* notify UI critically */ })
supervisor.start()
```

**File:** New `src/main/socket-supervisor.ts` (~80 lines)

### 3. Sentinel Socket Health Check

Extend existing Sentinel sweep loop with an 8th check that probes the socket.

- Sentinel gets a reference to `SocketSupervisor` via `SentinelDeps`
- Each sweep: connects to socket, sends `ping`, expects `pong` within 5 seconds
- Tracks consecutive failures. After 3 consecutive failed pings, tells supervisor to restart
- Logs failures to `ships_log`, sends comms alert to admiral on restart (deduplicated via existing `lastAlertLevel` pattern)

**Separation of concerns:**
- Sentinel does detection (sweep loop, alerting infrastructure)
- Supervisor does restart (mechanics, backoff logic)

**File:** `sentinel.ts` (~20 lines added, new dep in `SentinelDeps`)

### 4. CLI Retry with Wait-for-App

New `sendWithRetry()` method on `FleetCLI`, used by `runCLI()`.

**Behavior:**
- Socket file missing: poll every 500ms for up to 15 seconds. Prints `"Waiting for Fleet app to start..."`
- ECONNREFUSED: retry up to 4 times with exponential backoff (200ms, 600ms, 1.8s, 5.4s)
- Other errors (timeout, invalid JSON, unknown command): fail immediately — not transient

**`send()` stays unchanged** for internal callers wanting raw single-shot behavior.

**Integration:** `runCLI()` changes `cli.send()` to `cli.sendWithRetry()`.

**File:** `fleet-cli.ts` (~40 lines added)

### 5. Startup Recovery Enhancements

- Before creating `SocketSupervisor`, check for stale `fleet.sock`. If it exists but no Fleet process owns it (lockfile PID check), remove it and log
- After `SocketSupervisor.start()`, send `ping` to verify socket is healthy
- If ping fails on startup, supervisor's normal restart logic handles it — don't block app launch
- Existing reconciliation (lost crew, worktree pruning, mission requeue) untouched

**File:** `index.ts` (~10 lines added)

## Touch Points Summary

| Component | File | Change Size |
|-----------|------|-------------|
| `ping` command | `socket-server.ts` | ~5 lines |
| Socket Supervisor | `socket-supervisor.ts` | New file, ~80 lines |
| Sentinel health check | `sentinel.ts` | ~20 lines |
| CLI retry | `fleet-cli.ts` | ~40 lines |
| Startup recovery | `index.ts` | ~10 lines |

## What's NOT Changing

- No separate daemon process — recovery is within the Electron process
- No auto-launch of Electron from CLI
- Existing reconciliation, lockfile, and Sentinel sweeps 1-7 untouched
- `SocketServer` class internals unchanged (Supervisor wraps it)
- `socket-api.ts` (legacy) not touched
