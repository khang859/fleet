# Kanban Phase 6 — Scheduled Tasks Design

**Status:** Approved (design)
**Date:** 2026-05-31
**Parent spec:** `docs/superpowers/specs/2026-05-30-kanban-board-design.md` (§ Non-goals — "Scheduled tasks (Hermes' `scheduled` status / scheduler)")

## Goal

Let users schedule kanban tasks to run at a future time and/or on a recurring
cadence. Scheduling lives **on the task** via a new `scheduled` status plus a
small set of additive columns — no separate entity. One-shot tasks run **in
place** at their time; recurring tasks act as **templates** that spawn a fresh
instance task on each fire. This is the first Phase 6 subsystem, built on the
completed Phase 5 kanban (single DB, dispatcher, boards, orchestrator,
worktrees, attachments).

## Decisions (settled during brainstorming)

- **Capability:** one-shot **and** recurring schedules in v1.
- **Recurrence model:** a recurring task is a **template** that never runs
  itself; each fire spawns a fresh instance task that flows through the normal
  pipeline. Clean per-occurrence history (each instance has its own run, diff,
  result). Mirrors hermes-agent's per-run output.
- **One-shot model:** runs **in place** (time-gated) — the same task transitions
  to `ready` and runs once at its time. No instance, no template.
- **Recurrence format:** both a simple **interval** (every N units) and **cron**
  expressions in v1. Cron uses the `cron-parser` library.
- **Missed fires (app closed):** **skip missed, realign only** for recurring —
  advance `next_run_at` to the next future fire without spawning. (One-shots are
  a deliberate single request, so an overdue one-shot runs once on reopen — see
  § One-shot overdue.)
- **Storage:** reuse the `tasks` table + a `scheduled` status (not a separate
  `schedules` table). Matches the parent spec's "Hermes' `scheduled` *status*"
  framing and reuses task CRUD, board scoping, assignee, workspace/repo fields,
  and the existing event/refresh plumbing.
- **Worker/MCP surface:** scheduling is a **UI operation**; workers get no
  scheduling MCP tools (consistent with boards/attachments). Spawned instances
  are ordinary work tasks.

## Background / grounding

- Task statuses today (`src/shared/kanban-types.ts`):
  `triage → todo → ready → running → blocked → done → archived`. Single
  `kanban.db` at `KANBAN_HOME/kanban.db`.
- `migrate()` (`kanban-store.ts`) runs `SCHEMA_SQL` (all `CREATE … IF NOT
  EXISTS`) unconditionally first, then version-gated additive blocks using
  `addColumnIfMissing(table, column, decl)` (a `PRAGMA table_info` guard,
  idempotent on fresh and existing DBs), then sets `user_version`. **CRITICAL
  learning (from the v5 boards migration):** a `CREATE INDEX … ON tasks(newcol)`
  must **not** live in `SCHEMA_SQL` if the column is added by a later
  `addColumnIfMissing` — `SCHEMA_SQL` runs first and would reference a
  not-yet-existing column on pre-existing DBs. This design adds **no** index, so
  the trap does not apply, but any future index on a new column must go inside
  the version-gated block after `addColumnIfMissing`.
- The dispatcher (`kanban-dispatcher.ts`) ticks every `intervalMs` (default
  `5000`). `tick()` runs `reclaim → decompose → promote → claimAndSpawn`, all
  synchronous. `now()` is injected via `deps.now()` (so tests control time).
  `promote()` moves `todo` tasks to `ready` once their parent links are `done`;
  `claimAndSpawn()` then claims `ready` tasks and spawns workers. The atomic-tick
  invariant: no `await` between a CAS-claim and a spawn.
- `createTask(input)` (`kanban-store.ts`) accepts `status` (default `'todo'`)
  and all the fields an instance needs to copy: `title`, `body`, `assignee`,
  `priority`, `tenant`, `workspaceKind`, `repoPath`, `branchName`,
  `modelOverride`, `skills`, `boardId`, `maxRuntimeSeconds`, `maxRetries`.
- Live refresh: `store.appendEvent` → `onEvent` → renderer `KANBAN_EVENT`
  (board + open-detail refetch). Board ops use a parallel
  `KANBAN_BOARDS_CHANGED` broadcast; schedule changes reuse the task
  `KANBAN_EVENT` feed (they are task-scoped).

## Status & lifecycle

Add `scheduled` to `TaskStatus`. Both one-shot and recurring tasks rest in
`scheduled` (a visible "Scheduled" lane). Firing behavior branches on
`schedule_kind`:

- **One-shot (`once`):** when `now >= next_run_at`, the **same task** transitions
  `scheduled → ready` and runs once in place. After it runs it is an ordinary
  task in its terminal state.
- **Recurring (`interval` | `cron`):** a **template** that never runs itself. On
  fire it spawns a fresh instance task (see § Instance spawning), stays
  `scheduled`, and advances `next_run_at`.

### One-shot overdue (app was closed)

An overdue one-shot (its time passed while Fleet was closed) **runs once on
reopen** — `fireSchedules` transitions it to `ready` whenever `now >=
next_run_at`, regardless of how overdue. It is a deliberate single request, so
no grace/skip applies. (Alternative considered: mark it "missed". Rejected — a
one-shot exists to run, and silently dropping it surprises the user.)

### Recurring missed fires (skip-missed, realign)

On each tick, for a due recurring template (`next_run_at <= now`, not paused):

- If `now − next_run_at > GRACE_MS` → the fire was missed while the app was
  closed. **Realign only:** advance `next_run_at` to the next fire strictly
  after `now`, **do not** spawn. Append a `schedule_realigned` event.
- Else (fired during normal operation) → **fire:** spawn an instance, advance
  `next_run_at` to the next fire after `now`, append a `schedule_fired` event.

`GRACE_MS = max(2 × dispatcher intervalMs, 60_000)`. With the default 5s tick,
that is 60s — a live app always catches a fire within grace; a reopen gap > 60s
reads as missed.

### Instance spawning (recurring fire)

`spawnScheduledInstance(template)` calls `createTask` copying `title`, `body`,
`assignee`, `priority`, `tenant`, `workspaceKind`, `repoPath`, `branchName`,
`modelOverride`, `skills`, `boardId`, `maxRuntimeSeconds`, `maxRetries`, with
`status: 'todo'` and `scheduled_from = template.id`. The instance has no parent
links, so `promote()` moves it to `ready` on a subsequent tick and it runs as a
normal work task. The instance title is the template title (provenance is the
`scheduled_from` column + the `schedule_fired` event carrying the instance id);
no title mangling.

## Data model (schema v6)

Bump `SCHEMA_VERSION` 5 → 6. Additive columns on `tasks`, **all** added via
`addColumnIfMissing` inside `if (current < 6)`:

```sql
schedule_kind        TEXT             -- null | 'once' | 'interval' | 'cron'
schedule_cron        TEXT             -- cron expression (cron kind only)
schedule_interval_ms INTEGER          -- period in ms (interval kind only)
next_run_at          INTEGER          -- next fire (epoch ms); for 'once' == the fire time
schedule_paused      INTEGER NOT NULL DEFAULT 0
scheduled_from       TEXT             -- instance provenance: template task id (null otherwise)
```

`schedule_kind = null` means the task is not scheduled. The `tasks` CREATE in
`SCHEMA_SQL` also gains these columns (covers fresh DBs); the
`addColumnIfMissing` calls cover existing v5 DBs and are idempotent on fresh
ones. **No index** — the `scheduled` set is tiny and the fire query already
filters on `status='scheduled'`. No FK constraint (the schema declares none;
orphan rows are the existing norm). Existing tasks migrate with all six fields
at their defaults — unaffected.

## Pure schedule helper (`src/main/kanban/schedule.ts`)

Electron-free and unit-testable. The store/dispatcher import it; no
better-sqlite3 or `dialog` dependency.

```ts
export type ScheduleInput =
  | { kind: 'once'; at: number }            // epoch ms
  | { kind: 'interval'; everyMs: number }   // > 0
  | { kind: 'cron'; expr: string };         // valid cron expression

// Next fire strictly after `after` (epoch ms). For 'once', returns `at`.
// For 'interval', advances `anchor + everyMs` forward until > after.
// For 'cron', uses cron-parser's next() seeded at `after`.
export function computeNextRun(input: ScheduleInput, after: number): number;

// Validates an input: rejects non-positive intervals and invalid cron
// expressions. Returns { ok: true } | { ok: false; error: string }.
export function validateSchedule(input: ScheduleInput): { ok: true } | { ok: false; error: string };
```

New dependency: **`cron-parser`** (main process only), used by `computeNextRun`
(cron `next`) and `validateSchedule` (parse-or-throw → error string).

## Dispatcher

Add a synchronous `fireSchedules()` step. New tick order:

```
reclaim → fireSchedules → decompose → promote → claimAndSpawn
```

(placing `fireSchedules` before `promote`/`claimAndSpawn` lets a newly-ready
one-shot and a freshly-spawned instance be considered the same tick). No
`await` is introduced — all store calls are synchronous better-sqlite3 — so the
atomic-tick invariant holds.

```
fireSchedules():
  const now = this.deps.now()
  for (const t of this.store.dueSchedules(now)):   // status='scheduled', not paused, next_run_at <= now
    if (t.scheduleKind === 'once'):
      this.store.fireOnce(t.id)                     // scheduled → ready
      this.store.appendEvent(t.id, null, 'schedule_fired', { kind: 'once' })
    else:                                           // 'interval' | 'cron'
      const next = computeNextRun(scheduleOf(t), now)
      if (now - t.nextRunAt > GRACE_MS):
        this.store.advanceNextRun(t.id, next)
        this.store.appendEvent(t.id, null, 'schedule_realigned', { nextRunAt: next })
      else:
        const instance = this.store.spawnScheduledInstance(t)
        this.store.advanceNextRun(t.id, next)
        this.store.appendEvent(t.id, null, 'schedule_fired', { kind: t.scheduleKind, instanceId: instance.id })
```

`GRACE_MS = max(2 * (this.deps.intervalMs ?? 5000), 60_000)`.

## Store / command / type / IPC wiring

- **`src/shared/kanban-types.ts`** — add `scheduled` to `TaskStatus`; add to
  `Task`: `scheduleKind: 'once' | 'interval' | 'cron' | null`,
  `scheduleCron: string | null`, `scheduleIntervalMs: number | null`,
  `nextRunAt: number | null`, `schedulePaused: boolean`,
  `scheduledFrom: string | null`. Export `ScheduleInput` (the discriminated
  union above).
- **`src/main/kanban/kanban-store.ts`** — `rowToTask` maps the six new columns;
  new methods: `setSchedule(taskId, input)` (validates via `validateSchedule`,
  sets the kind-specific columns + `next_run_at = computeNextRun(input, now)` for
  recurring or `at` for once, status → `scheduled`, clears paused),
  `clearSchedule(taskId)` (nulls schedule columns, status → `todo`),
  `pauseSchedule`/`resumeSchedule` (toggle `schedule_paused`; recurring only),
  `dueSchedules(now)` (`SELECT * … WHERE status='scheduled' AND schedule_paused=0
  AND next_run_at <= ?`), `advanceNextRun(taskId, nextRunAt)`,
  `fireOnce(taskId)` (`scheduled → ready`), `spawnScheduledInstance(template)`.
- **`src/main/kanban/kanban-commands.ts`** — `setSchedule(taskId, input)`,
  `clearSchedule(taskId)`, `pauseSchedule(taskId)`, `resumeSchedule(taskId)`:
  `requireTask`, validate (throw `CodedError(msg, 'BAD_REQUEST')` on invalid
  cron / non-positive interval), call the store, `appendEvent` for parity and
  live refresh.
- **`src/shared/ipc-channels.ts`** — `KANBAN_SET_SCHEDULE`,
  `KANBAN_CLEAR_SCHEDULE`, `KANBAN_PAUSE_SCHEDULE`, `KANBAN_RESUME_SCHEDULE`,
  `KANBAN_PREVIEW_SCHEDULE` (returns the next ~3 fire times for a
  `ScheduleInput`, or a validation error).
- **`src/shared/ipc-api.ts`** — request types + `window.fleet.kanban.*` method
  signatures.
- **`src/main/kanban/kanban-ipc.ts`** — register the five handlers (they run
  outside the dispatcher tick).
- **`src/preload/index.ts`** — add the five methods to the `kanban` block.

## Renderer

- **`KanbanBoard`** — a "Scheduled" lane/column showing each scheduled task with
  its next-fire time and recurrence summary (e.g. "Daily 9:00" or "every 2h"),
  plus pause/resume and edit affordances. Recurring instances appear in the
  normal lanes (todo/ready/running/…) like any task.
- **`KanbanDrawer`** — a **Schedule** section: pick kind (once / interval /
  cron); set a datetime (once), `N` + unit (interval), or a cron expression;
  show a live preview of the next few fire times. Because cron parsing lives in
  the main process (`cron-parser`), the preview is computed via a single
  `KANBAN_PREVIEW_SCHEDULE` IPC call that returns the next ~3 fire times for a
  `ScheduleInput` (it reuses `computeNextRun` iteratively and `validateSchedule`,
  returning a validation error for malformed input). Clear / pause / resume
  controls.
- **`src/renderer/src/store/kanban-store.ts`** — scheduled tasks arrive via the
  existing board fetch; add `setSchedule`, `clearSchedule`, `pauseSchedule`,
  `resumeSchedule` actions.

## Error handling

- **Invalid cron / non-positive interval** → `BAD_REQUEST`, surfaced inline in
  the drawer Schedule section.
- **Paused recurring template** → never fires; `dueSchedules` filters
  `schedule_paused=0`.
- **Recurring fire while a prior instance is still running** → independent;
  instances are ordinary tasks subject to the normal `maxInProgress` cap. No
  special interlock in v1 (a slow instance plus a fast cadence simply queues
  more instances, bounded by the dispatcher cap).
- **`computeNextRun` returns a time still ≤ now** (cron edge) → the loop
  advances strictly past `now`; the helper guarantees a result `> after`.

## Testing strategy

- **`schedule.ts`** — `computeNextRun`: `once` returns `at`; `interval` advances
  forward past `after` (skip-missed: large gap lands on the first future
  multiple); `cron` matches `cron-parser`'s next for a few expressions.
  `validateSchedule`: rejects `everyMs <= 0` and invalid cron; accepts valid.
- **Store** — `setSchedule` sets columns + `next_run_at` + status `scheduled`;
  `clearSchedule` → `todo`, columns null; `pause`/`resume` toggle the flag;
  `dueSchedules` returns only unpaused scheduled rows with `next_run_at <= now`;
  `spawnScheduledInstance` copies all fields, inherits `board_id`, sets
  `scheduled_from`, status `todo`; `fireOnce` → `ready`.
- **Dispatcher `fireSchedules`** — one-shot due → task to `ready`; recurring due
  within grace → spawns an instance + advances `next_run_at`; recurring missed
  (`> GRACE_MS` old) → realigns `next_run_at` with **no** spawn; paused recurring
  → no fire; verifies no `await` (atomic tick). Uses an injected `now()`.
- **Migration** — a v5 DB opens at v6 with the six columns present, existing
  rows intact and `schedule_kind = null`.
- **Commands** — `setSchedule` rejects invalid cron / non-positive interval with
  `BAD_REQUEST`; valid input round-trips and logs an event.

## Non-goals (v1)

- No worker/MCP scheduling tools (scheduling is UI-only).
- No calendar/visual scheduler UI (text fields + a next-fire preview).
- No timezone selector — schedules evaluate in the host's local time.
- No backfill of missed recurring fires (skip-missed is the chosen behavior).
- No per-occurrence retry policy distinct from a normal task's `max_retries`.
- No running-instance interlock (overlapping instances are bounded only by the
  dispatcher's `maxInProgress` cap).
