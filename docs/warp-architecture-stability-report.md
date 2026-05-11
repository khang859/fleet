# Warp Architecture Stability Report

Date: 2026-05-10

## Purpose

Review `reference/warp` for architectural patterns Fleet can adopt to become more stable and robust. This is intentionally not a feature comparison; the focus is ownership, lifecycle, event flow, diagnostics, and testability.

## Executive Summary

Warp's most transferable architectural patterns are:

- explicit PTY/session ownership and deterministic shutdown
- centralized PTY write arbitration
- typed event dispatch from low-level terminal events into UI/app models
- throttled/coalesced rendering and state updates
- bounded diagnostics/telemetry buffers
- privacy-aware logging/redaction
- scoped feature-flag overrides for tests
- hermetic lifecycle/integration tests

Fleet already has the beginnings of this architecture with `PtyManager`, typed `EventBus`, `PtyDataRouter`, `SocketSupervisor`, targeted tests, and learnings docs. The highest-leverage improvement is to make each pane's PTY a first-class lifecycle-owned session object.

## Highest-Leverage Architectural Improvements for Fleet

### 1. Introduce a per-session lifecycle owner

Warp has a `TerminalManager` that owns the terminal model, PTY event loop, view, controllers, inactive receivers, and teardown path. Its drop path sends shutdown, joins the event-loop thread, closes receivers, and kills the PTY only in the correct cases.

Fleet previously had `src/main/pty-manager.ts` as a central registry where each PTY entry directly held:

- process
- output buffer
- paused flag
- data/exit disposables
- cwd

Fleet now has the first iteration of this pattern in `src/main/pty-session.ts`, with `PtyManager` acting as the session registry/delegator. Each `PtySession` owns:

- node-pty process
- data subscription
- exit subscription
- output batching buffer
- paused/resume state
- lifecycle state: `starting | running | exiting | exited | killed`
- idempotent teardown

Still to add in later phases:

- write queue/state
- resize state beyond guarded forwarding
- per-session diagnostics

Why this matters for Fleet: many historical Fleet learnings are lifecycle bugs — duplicate PTYs, blank terminals after pane close, hard refresh paused PTY, and lingering sessions. A session owner gives us one place to enforce ordering and cleanup.

Recommended shape:

```ts
class PtySession {
  readonly paneId: string;
  private state: 'starting' | 'running' | 'exiting' | 'exited' = 'starting';

  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string, paused: boolean) => void): void;
  onExit(cb: (exitCode: number) => void): void;

  shutdown(reason: 'user' | 'gc' | 'app-quit' | 'process-exit'): void;
}
```

Implemented in PR #204: `PtyManager` is now a map of session owners rather than the place where all lifecycle logic accumulates. It still owns cross-session policy such as protected PTYs, renderer-driven GC, and the shared flush timer.

### 2. Add a centralized PTY write arbiter

Warp routes writes through `PtyController`, not directly from views. It coordinates raw bytes, user commands, agent commands, in-band commands, cancellation, and readiness.

Fleet currently exposes:

```ts
PtyManager.write(paneId, data)
PtyManager.resize(paneId, cols, rows)
```

That is simple, but different call paths can interleave writes without policy. For agent terminals, this can cause subtle corruption: user keystrokes, automated commands, approval responses, and bridge/control messages can race.

Fleet should adopt a lightweight write queue per `PtySession`. PR #204 already added lifecycle guards so writes/resizes after exit or kill are ignored; the remaining work is arbitration between valid writes:

- classify writes:
  - `user-input`
  - `agent-input`
  - `control`
  - `bootstrap`
- define priority/cancellation rules:
  - user input can cancel stale automated writes
  - writes after exit are ignored and logged — implemented as lifecycle guard in PR #204
  - resize after exit is ignored and logged — implemented as lifecycle guard in PR #204
  - pending bootstrap writes can only happen during `starting` or `running`

This does not need Warp's complexity. A small queue/state machine would make Fleet more predictable.

### 3. Separate raw PTY data flow from app/model events

Warp bridges low-level terminal parsing events into a typed `ModelEventDispatcher`. Fleet has `src/main/event-bus.ts` with typed events, which is good, but PTY output, CWD detection, notifications, activity state, and copilot/session state are still relatively independent streams.

A stronger architecture would be:

```text
Raw PTY data
  -> parsers/detectors
    -> typed session events
      -> stores/UI/socket notifications
```

Example event model:

```ts
type SessionEvent =
  | { type: 'pty:data'; paneId: string; bytes: number; timestamp: number }
  | { type: 'pty:exit'; paneId: string; exitCode: number | null }
  | { type: 'cwd:changed'; paneId: string; cwd: string; source: 'osc7' | 'poll' }
  | { type: 'activity:changed'; paneId: string; state: ActivityState }
  | { type: 'agent:phase-changed'; sessionId: string; phase: CopilotSessionPhase };
```

Fleet already has pieces of this. The improvement is to make the dispatcher the only way derived state changes are emitted, with tests for "no duplicate event on no-op update."

### 4. Add diff-before-emit rules for noisy state

Warp avoids redundant events for unchanged session/environment state.

Fleet can apply this in:

- `CopilotSessionStore.processHookEvent`
- CWD polling
- activity tracker
- notification state
- workspace/layout save events
- socket subscription events

For example, `CopilotSessionStore.processHookEvent` always calls `onChange` after processing, even if the effective session state did not change. That is simple, but noisy. A snapshot/diff helper would reduce React churn and make behavior more testable.

Pattern:

```ts
const before = stableSessionSnapshot(session);
applyEvent(session, event);
if (!deepEqual(before, stableSessionSnapshot(session))) {
  this.onChange?.();
}
```

This is not only about performance; it prevents feedback loops and makes race bugs easier to reason about.

### 5. Add bounded diagnostics ring buffers

Warp uses bounded telemetry/network diagnostics buffers and bounded queues so diagnostic collection cannot destabilize the app.

Fleet has logging via `src/main/logger.ts`, but no apparent bounded per-subsystem diagnostics buffer. Fleet should add an in-memory ring buffer for:

- PTY lifecycle events
- PTY writes/resizes/exits
- socket API requests
- bridge websocket messages
- copilot hook events
- image jobs
- workspace/layout persistence

Example:

```ts
type DiagnosticEvent = {
  timestamp: number;
  subsystem: 'pty' | 'socket' | 'bridge' | 'copilot' | 'layout';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
};
```

Keep only the last N events, e.g. 500 or 1000. Expose it through the socket API or a debug UI later.

This would help debug "Fleet feels unstable" issues without requiring users to reproduce with verbose logs.

### 6. Add safe/redacted logging helpers

Warp has safe logging and secret redaction before data leaves the device. Fleet logs paths, commands, prompts, image prompts, socket details, bridge events, and errors.

Fleet should add a small redaction layer:

- redact obvious API keys/tokens
- redact bridge tokens
- redact `FLEET_BRIDGE_TOKEN`
- redact env values unless allowlisted
- avoid logging full terminal data by default

Possible shape:

```ts
log.info('Bridge connection accepted', redactMeta({ paneId, token }));
```

or implement redaction inside `createLogger`.

This is architectural robustness because once diagnostics are expanded, privacy/safety needs to be built in.

### 7. Add typed feature flags with runtime/test overrides

Warp has typed feature flags with scoped test overrides and propagation into spawned threads.

Fleet currently uses settings, but there is no obvious typed feature flag layer. For robustness work, this would let Fleet ship risky internals behind flags:

- new PTY session owner
- PTY write queue
- bounded diagnostics
- stricter no-op event suppression
- new copilot JSONL parser behavior

Recommended shape:

```ts
export type FeatureFlag =
  | 'ptySessionOwner'
  | 'ptyWriteQueue'
  | 'boundedDiagnostics'
  | 'strictSessionEvents';

export function isFeatureEnabled(flag: FeatureFlag): boolean;
export function withFeatureOverride<T>(flag: FeatureFlag, enabled: boolean, fn: () => T): T;
```

This gives us dogfoodability without scattering `process.env` checks everywhere.

### 8. Make async lifecycle waits explicit and timeout-bound

Warp's agent/terminal driver uses explicit conditions and timeouts for lifecycle milestones:

- wait for terminal bootstrap
- wait for session sharing
- classify timeout errors distinctly

Fleet has some timeouts already, e.g. annotate service and CLI tests, but terminal/agent lifecycle would benefit from explicit conditions:

- wait for PTY created
- wait for first output
- wait for bridge connected
- wait for copilot session observed
- wait for process exit

This prevents promises from waiting forever and makes tests deterministic.

## Fleet-Specific Priority Order

### Phase 1 — PTY lifecycle hardening

Status: mostly implemented in PR #204.

Completed:

1. Introduced `PtySession` owner internally behind `PtyManager`.
2. Made teardown idempotent and stateful.
3. Moved PTY attach buffer draining behind `PtyManager.drainBuffer()` so callers no longer mutate output buffer internals directly.
4. Added tests for:
   - duplicate create returns existing session
   - kill twice is safe
   - resize after kill is ignored
   - write after natural exit is ignored
   - resize after natural exit is ignored
   - natural exit cleans buffers/listeners and removes the session
   - natural exit removes the session even without an external `onExit` callback
   - GC does not kill protected PTYs

Remaining Phase 1 follow-ups:

- Consider replacing `PtyManager.get()` with narrower read-only accessors so callers cannot grow new dependencies on `PtySession` internals.
- Add an integration-style lifecycle test with a real PTY once the harness can do this hermetically.

### Phase 2 — Write queue and event hygiene

1. Add per-session write queue / arbiter.
2. Classify writes by source.
3. Add no-op suppression to noisy stores.
4. Add tests for write ordering and stale writes.

### Phase 3 — Diagnostics

1. Add bounded ring buffer.
2. Instrument PTY lifecycle, socket server, Fleet bridge, and copilot hook events.
3. Add redaction helpers.
4. Add a socket/debug command to dump diagnostics.

### Phase 4 — Feature flags and hermetic integration tests

1. Add typed feature flags with scoped test overrides.
2. Add integration-style tests with isolated HOME and temp workspace.
3. Test full path:
   - create workspace
   - create PTY
   - send command
   - receive output
   - close pane
   - assert no live listeners/PTYs

## Concrete Patterns from Warp to Adapt

- Use ownership boundaries, not shared ad-hoc lifecycle logic.
- Centralize PTY writes; do not let every caller write directly.
- Throttle UI wakeups separately from PTY data ingestion.
- Use bounded buffers everywhere diagnostics/telemetry can grow.
- Treat no-op state changes as no events.
- Use explicit conditions with timeouts for lifecycle milestones.
- Make cleanup deterministic and idempotent.
- Test lifecycle sequencing more than visual behavior.

## Evidence from Warp

Key files inspected:

- `reference/warp/app/src/terminal/local_tty/terminal_manager.rs`
- `reference/warp/app/src/terminal/local_tty/event_loop.rs`
- `reference/warp/app/src/terminal/writeable_pty/pty_controller.rs`
- `reference/warp/app/src/terminal/model/session.rs`
- `reference/warp/app/src/terminal/model_events.rs`
- `reference/warp/app/src/terminal/event_listener.rs`
- `reference/warp/app/src/terminal/view.rs`
- `reference/warp/app/src/terminal/local_tty/spawner.rs`
- `reference/warp/app/src/terminal/local_tty/server/mod.rs`
- `reference/warp/crates/warp_features/src/lib.rs`
- `reference/warp/app/src/crash_reporting/mod.rs`
- `reference/warp/app/src/server/telemetry/collector.rs`
- `reference/warp/app/src/server/telemetry/secret_redaction.rs`
- `reference/warp/app/src/server/network_logging.rs`
- `reference/warp/app/src/server/network_logging_tests.rs`
- `reference/warp/app/src/terminal/writeable_pty/pty_controller_tests.rs`
- `reference/warp/app/src/terminal/model/session_tests.rs`
- `reference/warp/.agents/skills/warp-integration-test/SKILL.md`

## Risks and Adaptation Notes

- Warp is Rust/WarpUI; Fleet is Electron/TypeScript/node-pty, so patterns should be adapted, not ported wholesale.
- Warp still uses panics for some hard invariants; Fleet should prefer recoverable errors at Electron process boundaries.
- Terminal-server subprocess isolation may be overkill for Fleet initially. Lifecycle ownership, bounded queues, and diagnostics are higher-leverage first steps.

## Recommended First Implementation

Status: implemented in PR #204.

Fleet now turns each pane's PTY into a stateful `PtySession` owner and moves writes/resizes/data/exit cleanup through it while keeping the public `PtyManager` API mostly stable.

Implemented pieces:

- `src/main/pty-session.ts` owns the PTY process, data/exit listeners, output buffer, paused state, lifecycle state, and idempotent shutdown.
- `src/main/pty-manager.ts` stores `PtySession` instances and delegates per-session lifecycle operations.
- `PTY_ATTACH` uses `PtyManager.drainBuffer()` instead of mutating PTY entry internals directly.
- Natural PTY exits now clean up the session even if no external `onExit` callback was registered.
- Writes/resizes after natural exit or kill are ignored.

This directly addresses the class of bugs Fleet has historically hit:

- duplicate PTYs
- renderer reload races
- stale listeners
- writes/resizes after exit
- blank terminal after close
- paused PTYs after refresh
- cleanup ordering bugs

Validation for PR #204:

```bash
npm run typecheck:node
npx vitest run src/main/__tests__/pty-manager.test.ts src/main/__tests__/pty-manager-extended.test.ts
```

Full lint was also attempted, but the repo currently has unrelated pre-existing lint errors outside this change.
