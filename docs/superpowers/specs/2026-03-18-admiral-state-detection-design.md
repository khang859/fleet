# Admiral Terminal State Detection

## Overview

Extend the existing `notificationDetector` to parse Claude Code's TUI output from the Admiral PTY, detect state transitions, and update the `admiralAvatarState` in the Zustand store to drive avatar image and status text changes in the AdmiralSidebar.

## Goals

- Monitor Admiral PTY output in real-time to determine what Claude Code is doing
- Update the admiral avatar image and sidebar status text to reflect the current state
- Keep detection logic isolated in its own module for future extensibility (e.g. non-Claude-Code agents)

## State Detection Patterns (Claude Code TUI)

| State             | Detection Signal                                 | Avatar State | Avatar Image                                            | Status Text                |
| ----------------- | ------------------------------------------------ | ------------ | ------------------------------------------------------- | -------------------------- |
| Idle              | No output for ~2s                                | `standby`    | `admiral-standby`                                       | "Standing by"              |
| Thinking          | Spinner characters (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)                | `thinking`   | `admiral-thinking`                                      | "Thinking..."              |
| Speaking          | Streaming text output (non-spinner, non-tool)    | `speaking`   | `admiral-speaking` (oscillating with `admiral-default`) | "Speaking"                 |
| Tool execution    | Tool use block headers (e.g. `⏺ Bash`, `⏺ Read`) | `thinking`   | `admiral-thinking`                                      | "Executing: \<tool name\>" |
| Permission prompt | `(y/n)`, "Allow", permission patterns            | `alert`      | `admiral-alert`                                         | "Awaiting permission"      |
| Error             | "Error:", connection failures, crash output      | `alert`      | `admiral-alert`                                         | "Error"                    |
| Starting          | Admiral status is `'starting'`                   | `standby`    | `admiral-standby`                                       | "Starting..."              |
| Stopped           | Admiral status is `'stopped'`                    | `standby`    | `admiral-standby`                                       | "Standing by"              |

Note: Tool execution maps to `thinking` avatar state (not a new state) with a distinct status text. This keeps the `AdmiralAvatarState` type unchanged.

## Architecture

```
Admiral PTY data flush (every 16ms)
    ↓
ipc-handlers.ts: ptyManager.onData() / wireAdmiralPty()
    ↓
admiralStateDetector.scan(paneId, data)  ← called directly alongside notificationDetector
    ↓
Emits 'admiral-state-change' on eventBus
    ↓
IPC channel ADMIRAL_STATE_CHANGED → renderer process
    ↓
star-command-store updates admiralAvatarState + admiralStatusText
    ↓
AdmiralSidebar re-renders avatar image + status text
```

Note: `admiralStateDetector.scan()` is called directly in both `wireAdmiralPty()` and the generic PTY data handler, NOT buried inside `notificationDetector.scan()`. This prevents silent breakage if either path is refactored independently.

## Components

### 1. `src/main/starbase/admiral-state-detector.ts` (NEW)

Stateful scanner that tracks the Admiral's PTY output and determines the current state.

**Responsibilities:**

- Accept the Admiral's paneId so it only processes Admiral output
- Strip ANSI escape sequences from incoming data before pattern matching
- Maintain a rolling buffer (~1KB) of stripped output for multi-flush pattern matching
- Run regex patterns against cleaned data to detect state transitions
- Manage an idle timer (2s of silence → idle state)
- Debounce state changes by ~200ms to prevent flickering
- Emit `admiral-state-change` events on the eventBus

**ANSI stripping:**

```typescript
// Strip all ANSI escape sequences before pattern matching
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
function stripAnsi(data: string): string {
  return data.replace(ANSI_PATTERN, '');
}
```

**State priority (highest wins when ambiguous):**

1. Permission prompt / Error → `alert`
2. Tool execution → `thinking` (with tool-specific status text)
3. Speaking (streaming text fallback) → `speaking`
4. Thinking (spinner) → `thinking`
5. Idle (silence timeout) → `standby`

**Detection patterns:**

```typescript
// Thinking — braille spinner characters used by Claude Code
const THINKING_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

// Tool execution — Claude Code tool use headers
const TOOL_PATTERN =
  /⏺\s+(Bash|Read|Edit|Write|Glob|Grep|MultiEdit|TodoWrite|WebFetch|WebSearch|Agent|Skill|NotebookEdit)/;

// Permission prompt — reuse existing patterns + additions
const PERMISSION_PATTERNS = [
  /Do you want to (?:allow|proceed|continue)/i,
  /\(y\/n\)\s*$/,
  /Allow this action\?/i,
  /Press Enter to confirm/i
];

// Error patterns
const ERROR_PATTERNS = [/^Error:/m, /connection failed/i, /fatal:/i, /SIGTERM|SIGKILL/];

// Speaking — fallback: any non-empty output that doesn't match above patterns
```

**Interface:**

```typescript
interface AdmiralStateEvent {
  state: 'standby' | 'thinking' | 'speaking' | 'alert';
  statusText: string; // e.g. "Executing: Bash", "Thinking...", "Standing by"
}

class AdmiralStateDetector {
  constructor(eventBus: EventBus);
  setAdmiralPaneId(paneId: string | null): void;
  scan(paneId: string, data: string): void;
  reset(): void; // Reset to standby — called on Admiral stop
  dispose(): void; // Clean up timers and listeners
}
```

### 2. `src/main/event-bus.ts` (MODIFIED)

Add `admiral-state-change` to the `FleetEvent` union:

```typescript
| { type: 'admiral-state-change'; state: AdmiralAvatarState; statusText: string }
```

### 3. `src/main/ipc-handlers.ts` (MODIFIED)

- Call `admiralStateDetector.scan()` directly in both `wireAdmiralPty()` and the generic PTY data path, alongside `notificationDetector.scan()`
- Listen for `admiral-state-change` events on the eventBus and forward to renderer via `ADMIRAL_STATE_CHANGED` IPC channel

Note: `AdmiralStateDetector` is NOT instantiated here — it's instantiated in the main process entry point and passed in as a parameter, consistent with how `notificationDetector` is handled.

### 4. `src/main/index.ts` (MODIFIED)

- Instantiate `AdmiralStateDetector` at app startup
- Pass it to `registerIpcHandlers()` and `admiralProcess`
- Call `admiralStateDetector.dispose()` in the `will-quit` handler

### 5. `src/main/starbase/admiral-process.ts` (MODIFIED)

- Accept `AdmiralStateDetector` reference
- Call `admiralStateDetector.setAdmiralPaneId(paneId)` after starting the Admiral PTY
- Call `admiralStateDetector.reset()` when Admiral stops (ensures UI resets to `standby`)
- Call `admiralStateDetector.setAdmiralPaneId(null)` on stop

### 6. `src/shared/constants.ts` (MODIFIED)

Add `ADMIRAL_STATE_CHANGED` to IPC_CHANNELS.

### 7. `src/preload/index.ts` (MODIFIED)

Expose `window.fleet.admiral.onStateChanged(callback: (event: AdmiralStateEvent) => void): () => void` listener for the new IPC channel. The callback payload is strongly typed as `AdmiralStateEvent`.

### 8. `src/renderer/src/store/star-command-store.ts` (MODIFIED)

- Add `admiralStatusText: string` field (default: "Standing by")
- Add `setAdmiralState(state, statusText)` action to update both `admiralAvatarState` and `admiralStatusText`

### 9. `src/renderer/src/components/StarCommandTab.tsx` (MODIFIED)

- Subscribe to `window.fleet.admiral.onStateChanged()` in useEffect
- Call `setAdmiralState()` on the store with incoming events
- Keep the existing speaking oscillation logic (toggles `avatarVariant` prop between `'speaking'` and `'default'` every 300ms when `admiralAvatarState === 'speaking'`)
- `avatarVariant` remains a prop passed to AdmiralSidebar (not moved to store)

### 10. `src/renderer/src/components/star-command/AdmiralSidebar.tsx` (MODIFIED)

- Read `admiralStatusText` from store
- Display dynamic status text below the admiral avatar instead of hardcoded status labels
- `avatarVariant` continues to be received as a prop (no change to prop API)

## Debouncing & Edge Cases

- **Idle detection:** Start a 2s timer when no output is received. Cancel and reset on any new output. When timer fires, transition to `standby`. Idle emission bypasses the 200ms debounce (the 2s silence is already sufficient debouncing).
- **State priority:** If a permission prompt and tool execution are detected in the same flush, permission wins (higher priority).
- **Rapid transitions:** Debounce state emission by ~200ms. If a new state arrives within 200ms, cancel the previous emission and emit the new one instead. Exceptions that emit immediately (no debounce): `alert` state and `standby` (idle timeout).
- **Rolling buffer:** Keep the last ~1KB of ANSI-stripped output to handle patterns that span multiple 16ms flushes. Trim from the front when exceeding 1KB.
- **Admiral paneId changes:** When Admiral restarts, `admiralProcess` calls `setAdmiralPaneId()` with the new paneId. Old state and buffer are cleared.
- **Admiral stop:** When Admiral stops, `admiralProcess` calls `reset()` which emits `standby` + "Standing by" and clears all internal state/timers.
- **Tool name extraction:** The `TOOL_PATTERN` regex captures the tool name in group 1, used for "Executing: \<tool\>" status text.
- **App shutdown:** `admiralStateDetector.dispose()` is called in the `will-quit` handler to clean up timers and event listeners.

## Future Extensibility

The `AdmiralStateDetector` is designed as a standalone class that could be swapped out or extended for non-Claude-Code agents in the future. The detection patterns are grouped by state and easy to modify. The interface (`AdmiralStateEvent`) is agent-agnostic.
