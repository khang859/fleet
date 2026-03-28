# CLI-Agnostic Attention Detection for Fleet Tabs

**Date:** 2026-03-27
**Status:** Approved
**Related:** [#166 — RFC: Agent Provider Abstraction](https://github.com/khang859/fleet/issues/166)

## Problem

Fleet's tab system has no way to tell the user what's happening in inactive PTY sessions. When running multiple AI coding agents in parallel, users resort to tab-switching whack-a-mole to check "is it done?", "does it need me?", "is it still working?"

The removed JSONL pipeline was supposed to solve this but was dead code — the renderer never consumed it. The current `NotificationDetector` only catches a few Claude-specific permission patterns and OSC sequences. There is no idle/done/working detection at all.

## Goal

Add CLI-agnostic attention detection to Fleet's tab sidebar so users can answer "do any agents need me?" in a 2-second glance — without relying on any specific AI CLI's protocol.

## Non-Goals

- Replace or modify the starbase orchestration system (Hull, Navigator, etc.)
- Add LLM API calls for summarization
- Support CLI-specific structured output parsing (stream-json, JSONL, etc.)
- Shell integration hook injection (cmux's `preexec`/`precmd` approach) — deferred; `pty.process` polling achieves the same signal without requiring shell modification

## Research Summary

### Industry Approaches

| Tool | Approach | Strengths |
|------|----------|-----------|
| **tmux** | `monitor-silence` (timer), `monitor-activity` (any output), `monitor-bell` | Battle-tested, simple, universal |
| **cmux** | Shell hooks (`preexec`/`precmd`) + Claude hooks + OSC detection | Most accurate, but requires shell/agent integration |
| **Warp** | 5-state model (working/done/attention/idle/error) with 3-tier notifications | Best UX design, proprietary detection |
| **amux** | ANSI-stripped tmux output parsing, no hooks | Fully generic, no dependencies |
| **pixel-agents** | JSONL transcript parsing + timer-based permission detection | Claude-specific |
| **iTerm2** | OSC 133 shell integration + triggers + idle alerts | Standards-based, mature |

### UX Research (Baymard + NNG)

Key principles applied to this design:

1. **Two visual channels minimum** (Baymard) — Never convey state by color alone. Use color + shape/label.
2. **Three urgency tiers max** (Baymard) — More tiers cause confusion. Error, action-needed, informational.
3. **Quiet by default, loud by exception** (NNG) — Normal running state is visually minimal. Only deviations deserve prominence.
4. **Brief animation on change, then settle** (NNG) — 2-3 pulse cycles on state transition, then static. Never loop continuously.
5. **Persistent over transient** (NNG) — Badges over toasts. Users may not be looking when state changes.
6. **Indicators must have a lifecycle** (Baymard) — Appear, be actionable, resolve. Stale badges kill trust.
7. **Reserve red for errors only** (Baymard) — Amber for "needs me", blue for "done".
8. **Freshness signals** (NNG) — Time-since-last-activity distinguishes "done" from "stuck."
9. **Handle off-screen items** (Baymard) — Summary indicator when tabs with badges scroll out of view.
10. **Respect `prefers-reduced-motion`** (NNG/WCAG) — Replace animation with static indicators when reduced motion is preferred.

## State Model

Five states, three visual urgency tiers:

| State | Urgency Tier | Meaning |
|-------|-------------|---------|
| `working` | Low (quiet) | Output flowing, command running |
| `idle` | None | At shell prompt, nothing happening |
| `done` | Info | Command finished, unread output to review |
| `needs_me` | Action needed | Agent waiting for input/permission |
| `error` | Error | Process exited non-zero |

## Detection Layers

Each layer is independent. A state resolver picks the highest-confidence signal.

### Layer 1: Silence Timer (tmux pattern)

Every PTY gets a per-pane timer:

- **Output received** → reset timer, state = `working`
- **No output for 5s** → state = `idle` (threshold configurable)
- **Process exited, code 0** → state = `done`
- **Process exited, code != 0** → state = `error`

Handles "working" and "done" for every CLI with zero configuration.

### Layer 2: Output Pattern Matching (expand existing)

Expand `NotificationDetector`'s `PERMISSION_PATTERNS` to be CLI-agnostic:

```typescript
const PERMISSION_PATTERNS = [
  // Existing
  /Do you want to (?:allow|proceed|continue)/i,
  /\(y\/n\)\s*$/,
  /Allow this action\?/i,
  /Press Enter to confirm/i,
  // New generic patterns
  /\[Y\/n\]\s*$/,
  /\[yes\/no\]\s*$/i,
  /Continue\?\s*$/i,
  /Approve\?\s*$/i,
  /Press Enter to continue/i,
  /Are you sure\?/i,
  /\(yes\/no\)\s*$/i,
];
```

Any match → state = `needs_me`. Debounce at ~200ms to avoid mid-line false positives.

### Layer 3: `pty.process` Polling (node-pty)

Poll `pty.process` every 2s:

- Foreground process matches shell name (`zsh`, `bash`, `fish`, `sh`, `pwsh`) → `idle`
- Foreground process is something else → `working`

Cheap fallback confirming whether the shell is at a prompt without shell integration.

### Layer 4: OSC 133 Parsing (bonus)

Add to existing OSC parsing in `NotificationDetector`:

- `OSC 133;C` → command started → `working`
- `OSC 133;D;0` → command finished, exit 0 → `done`
- `OSC 133;D;N` (N > 0) → command finished, non-zero → `error`

Only fires when shell integration is active. Not required — just an accuracy bonus.

### State Resolver Priority

```
needs_me (pattern match) > error (exit code) > done (exit/OSC 133) > working (output) > idle (silence/process)
```

`needs_me` always wins — even if other layers say "working," a permission prompt means the agent is blocked.

## Tab Sidebar Visual Design

### Badge Config

| State | Color | Size | Animation | Label | Shown when |
|-------|-------|------|-----------|-------|------------|
| `working` | `bg-green-400` | `w-1.5 h-1.5` | None | — | Non-focused tabs only |
| `done` | `bg-blue-400` | `w-2 h-2` | None | — | Non-focused tabs with unread output |
| `needs_me` | `bg-amber-400` | `w-2.5 h-2.5` | Pulse 3x then static | `?` | Always until tab focused |
| `error` | `bg-red-400` | `w-2.5 h-2.5` | None | `!` | Always until tab focused |

Badges clear when the user focuses the tab (existing `clearPane` behavior).

`idle` state shows no badge — it's the default quiet state.

### Freshness Indicator

Add relative timestamp to each tab's subtitle (currently shows shortened CWD):

- **Working:** no timestamp (output is flowing)
- **Idle/Done:** `3m ago` in dimmed `text-neutral-600`
- **Needs me:** `2m waiting` in `text-amber-400`

### Off-screen Summary

When tabs with badges scroll out of view in the sidebar:

- Top edge: `↑ 2 need attention`
- Bottom edge: `↓ 1 done`

Small, dimmed text. Only appears when there are off-screen badges.

### Sound

- `needs_me` state: play existing audio chime (current behavior for permission notifications)
- All other states: silent by default
- User-configurable in settings (future)

### OS Notifications

- `needs_me` and `error` states when Fleet window is not focused
- Off by default, configurable in settings (future)
- Uses Electron's `Notification` API

### Accessibility

- Two visual channels for every state: color + size/label (WCAG 1.4.1)
- `aria-label` on badges with state description
- Respect `prefers-reduced-motion`: replace pulse with static indicator
- Minimum 3:1 contrast ratio for all badge colors against `bg-neutral-800`

## Files Changed

### New

- **`src/main/activity-tracker.ts`** — Per-pane activity tracking. Silence timer, `pty.process` polling, state resolution. Emits `activity-state-change` events on event bus.

### Modified

- **`src/main/notification-detector.ts`** — Remove Claude-specific comments. Expand permission patterns. Add OSC 133 parsing.
- **`src/shared/types.ts`** — Add `ActivityState` type (`'working' | 'idle' | 'done' | 'needs_me' | 'error'`). Add IPC channel types.
- **`src/renderer/src/store/notification-store.ts`** — Add activity state tracking per pane. Add `lastActivity` timestamp. Map activity states to badge levels.
- **`src/renderer/src/components/TabItem.tsx`** — Update `BADGE_CONFIG` for new states. Add freshness timestamp in subtitle. Add `prefers-reduced-motion` support.
- **`src/renderer/src/components/Sidebar.tsx`** — Add off-screen badge summary indicator.
- **`src/preload/index.ts`** and **`src/shared/ipc-api.ts`** — Wire up `activity-state-change` IPC channel.

### Not Changed

- Starbase system (Hull, Navigator, First Officer, Analyst, Sentinel)
- Socket server
- PTY manager (tap into existing data events, no modification needed)
