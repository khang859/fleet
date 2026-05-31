# Kanban Phase 7 — Notifications & Attention Surfacing

**Status:** Approved (design)
**Date:** 2026-05-31
**Owner:** @khang859

## Goal

Let users find out when headless kanban workers and scheduled tasks need
attention. Today the dispatcher runs `rune --prompt` workers as detached
background processes and the Phase 6 scheduler fires tasks while the app may be
unattended — but nothing tells the user when a worker finishes, fails, or gets
**blocked** waiting on a human. This phase closes that loop with two in-app
surfaces: a native OS notification and an unread-count badge on the Kanban tab.

External bridges (Slack / Telegram / Discord), sound, and a persisted
notification center are explicit non-goals for this cut.

## Background

- **Single event chokepoint.** Every `task_events` row flows through one
  `onEvent` callback wired in `src/main/index.ts:753` when the `KanbanStore` is
  constructed. It already fans out to the renderer (`KANBAN_EVENT` channel) and
  the CLI socket (`socketSupervisor.broadcastKanbanEvent`). This is the natural
  tap point — no new event infrastructure is needed.
- **No interactive permission gate.** Headless `rune --prompt` workers execute
  tools without an approval prompt, so there is no literal "needs-permission"
  event. The human-handoff signal is the **`blocked`** event: a worker calls
  `kanban_block` with a reason when it needs a human.
- **Existing OS-notification machinery.** Terminal panes already use Electron's
  `Notification` with coalescing, a per-level settings gate, and click-to-focus
  (`src/main/index.ts:541`–607). This phase mirrors that pattern for kanban,
  with a kanban-specific click target.
- **Single DB, multiple boards.** Boards are rows in a `boards` table inside one
  SQLite DB; tasks carry a `board_id` (`Task.boardId`). There is exactly one
  `KanbanStore` and one `onEvent` stream for all boards. `TaskEvent` does not
  carry a board slug, so the notification path resolves `taskId → task.boardId`
  via `store.getTask(taskId)`.
- **Existing notification settings shape.** `FleetSettings.notifications`
  (`src/shared/types.ts:170`) uses `{ badge, sound, os }` per category, with
  defaults in `src/shared/constants.ts:34`.

## Event taxonomy

Four notification **categories**, mapped from raw event kinds by a pure
classifier. Settings and badges are keyed by category (not by raw kind), so the
settings UI stays small.

| Category        | Source event kind(s)        | Meaning                          |
|-----------------|-----------------------------|----------------------------------|
| `blocked`       | `blocked`                   | A worker needs you               |
| `failed`        | `gave_up`, `spawn_failed`   | Task failed / couldn't start     |
| `completed`     | `completed`                 | Task finished successfully       |
| `scheduleFired` | `schedule_fired`            | A scheduled task fired           |

Every other event kind classifies to `null` (no notification). All four
categories default **ON** for both surfaces (`os` and `badge`).

## Architecture

A pure classifier is the single source of truth shared by both surfaces. The
main process owns OS notifications; the renderer owns the tab badge. Both read
the same per-category settings (already synced to both sides by the settings
store), so the two surfaces never drift.

```
task_events row
   │
   ├─ KanbanStore.onEvent (main, index.ts:753)
   │     └─ classifyKanbanEvent(kind) → category | null
   │           └─ if category && settings.kanban.notifications[category].os
   │                 → resolve task (title, boardId) → kanban OS-notif buffer
   │                     → coalesce (KANBAN_NOTIF_BATCH_MS) → Notification.show()
   │                           └─ click → focus window + fleet:kanban-focus-task
   │
   └─ KANBAN_EVENT push → renderer kanban store
         └─ classifyKanbanEvent(kind) → category | null
               └─ if category && settings.kanban.notifications[category].badge
                     && kanban tab not active → unreadCount += 1
```

### Unit: shared classifier (`src/shared/kanban-notifications.ts`)

- `export type KanbanNotifyCategory = 'blocked' | 'failed' | 'completed' | 'scheduleFired';`
- `export function classifyKanbanEvent(kind: string): KanbanNotifyCategory | null`
  — a single `switch`/map: `blocked→blocked`, `gave_up→failed`,
  `spawn_failed→failed`, `completed→completed`, `schedule_fired→scheduleFired`,
  default `null`.
- No dependencies on Electron, the DB, or React. Trivially unit-testable.

### Unit: settings (`src/shared/types.ts`, `src/shared/constants.ts`)

- Extend `KanbanSettings` with:
  ```ts
  notifications: Record<KanbanNotifyCategory, { os: boolean; badge: boolean }>;
  ```
  (Sound is intentionally omitted — out of scope this cut.)
- Default in `constants.ts`: all four categories `{ os: true, badge: true }`.
- `settings-store.ts` already deep-merges `kanban` from saved settings; confirm
  the new `notifications` key is preserved on load (merge `kanban.notifications`
  the same way `notifications` is merged at top level).

### Unit: main-process OS-notification path (`src/main/index.ts`)

Inside the existing `onEvent` handler:
1. `const category = classifyKanbanEvent(event.kind); if (!category) return;`
2. `const cfg = settingsStore.get().kanban.notifications[category]; if (!cfg.os) return;`
3. Resolve `const task = kanbanStore.getTask(event.taskId);` for `title` and
   `boardId` (skip notification if the task no longer exists).
4. Push `{ category, taskId, boardSlug: task.boardId, title: task.title }` to a
   **kanban-specific** coalescing buffer (separate from the pane buffer because
   the click target differs), with its own `KANBAN_NOTIF_BATCH_MS` timer
   mirroring `OS_NOTIF_BATCH_MS`.
5. On flush:
   - **Single item:** title = `Fleet — Kanban`, body names the task and category
     (e.g. `"Blocked: <title>"`). Click → focus window + send
     `fleet:kanban-focus-task` with `{ boardSlug, taskId }`.
   - **Burst (N>1):** body summarizes counts per category
     (e.g. `"3 task updates: 1 blocked, 2 completed"`). Click → focus window +
     send `fleet:kanban-focus-task` with `{ boardSlug }` of the highest-priority
     item (priority order: blocked > failed > completed > scheduleFired) and no
     `taskId` (just opens that board).

### Unit: renderer badge path (`src/renderer/src/store/kanban-store.ts` + tab UI)

- Add `unreadCount: number` (init 0) and `markKanbanSeen()` to the kanban store.
- A single subscription to `window.fleet.kanban.onEvent` (preload already
  exposes it at `src/preload/index.ts:470`) lives at app scope (e.g. in the
  component that renders tabs, or an effect in the root) so it runs regardless
  of whether the board is mounted. On each event:
  - `const category = classifyKanbanEvent(event.kind);`
  - if `category` and `settings.kanban.notifications[category].badge` and the
    Kanban tab is **not** the active tab (`workspaceStore.activeTabId` !== the
    kanban tab id) → `unreadCount += 1`.
- Clearing: when the Kanban tab becomes active, call `markKanbanSeen()`
  (`unreadCount = 0`). Wire this from the tab-activation path / a `useEffect` on
  the board mount keyed to active tab.
- The badge is **global** across all boards (one counter). Per-board breakdown
  is a noted future enhancement, not in this cut.
- Render the count using the existing tab-badge styling used for other tab
  indicators.

### Unit: deep-link IPC (`fleet:kanban-focus-task`)

- New channel constant `KANBAN_FOCUS_TASK` in `src/shared/ipc-channels.ts`.
- Preload: expose `onKanbanFocusTask(cb: (p: { boardSlug: string; taskId?: string }) => void): Unsubscribe`.
- Renderer handler: ensure a Kanban tab exists and is active (open one if none),
  `switchBoard(boardSlug)` if `activeBoardSlug !== boardSlug`, then if `taskId`
  is present `openTask(taskId)` (opens the drawer).

## Data flow

1. A worker/dispatcher writes a `task_events` row → `appendEvent` → `onEvent`.
2. **Main:** classify → settings gate (`os`) → resolve task → coalesce → OS
   notification. Click → focus + `fleet:kanban-focus-task`.
3. **Renderer (always):** `KANBAN_EVENT` → classify → settings gate (`badge`) →
   if kanban tab inactive, bump `unreadCount`. Tab activation clears it.
4. The board's live event stream (existing behavior) is unchanged; the badge and
   OS notification are additive consumers of the same stream.

## Error handling

- **Task deleted before notification flush:** `getTask` returns null → skip that
  item (don't crash the flush). Coalesced flush filters out null-resolved items.
- **Unknown event kind:** classifier returns `null` → no-op on both surfaces.
- **Notifications unsupported on platform:** guard with
  `Notification.isSupported()` exactly as the existing pane path does.
- **No Kanban tab open on deep-link:** renderer opens one before switching board
  / opening the task.
- **Settings missing the new key (older saved settings):** `settings-store`
  merge supplies defaults so `kanban.notifications[category]` is always defined.

## Testing

- **Classifier (`src/shared/__tests__/kanban-notifications.test.ts`)** — each
  source kind maps to the expected category; representative unknown kinds
  (`comment`, `heartbeat`, `promoted`, `task_created`) map to `null`.
- **Main OS-notification path** — category-off settings ⇒ no notification fired;
  a burst within the batch window coalesces into one notification; `getTask`
  returning null is skipped without throwing; single vs burst body text and
  click payload (`{ boardSlug, taskId }` vs `{ boardSlug }`). Drive via the
  exported flush/buffer logic with a stubbed `Notification` and stubbed store.
- **Renderer badge** — increments only when (category enabled for badge) AND
  (kanban tab not active); does not increment when tab active; `markKanbanSeen`
  resets to 0; a `badge:false` category never increments.
- **Settings round-trip** — defaults present; saved settings without the new key
  load with all categories defaulting to `{ os: true, badge: true }`.
- **Manual** — block a task from a worker, confirm OS notification + tab badge
  while on another tab; click the notification and confirm the board opens with
  the task drawer; flip a category off in settings and confirm it stops
  notifying; let several tasks complete in a burst and confirm one coalesced
  notification.

## Non-goals (this cut)

- External notification bridges (Slack / Telegram / Discord subscriptions).
- Notification **sound** for kanban categories.
- Persisted notification history / a notification center panel.
- Per-board badge breakdown (global count only).
- Any change to terminal-pane notification behavior.
- A "needs-permission" event (headless workers have no approval gate; `blocked`
  is the human-handoff signal).

## Open questions

None at design time. Implementation may choose the exact app-scope location for
the renderer event subscription and the precise coalesced body copy.
