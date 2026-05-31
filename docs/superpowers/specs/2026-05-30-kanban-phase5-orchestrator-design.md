# Kanban Phase 5 — Orchestrator / Auto-Decompose Design

**Status:** approved (2026-05-30)
**Parent spec:** `docs/superpowers/specs/2026-05-30-kanban-board-design.md` (§ Orchestrator / auto-decompose, § Phasing item 5)

## Goal

Let a rough `triage` task be expanded into a child-task graph by an **orchestrator**
Rune run, and let a single task be rewritten into a fuller spec by a lighter
**specify** run — driven from the board drawer, the CLI, or (optionally) the
dispatcher itself. This brings Hermes' decomposition workflow to Fleet: route,
don't execute.

Phase 5 of the Kanban board is four independent subsystems (worktrees,
attachments, orchestrator/auto-decompose, multiple boards), each shipped on its
own spec → plan → implementation cycle. **This spec covers orchestrator /
auto-decompose only.**

## Scope (v1)

- ⚗ **Decompose** — manual drawer button + `fleet kanban decompose <id>` +
  optional dispatcher auto-trigger (`auto_decompose`).
- ✨ **Specify** — manual drawer button + `fleet kanban specify <id>`.
- The **orchestrator MCP role** (decompose + specify toolsets) on the existing
  `KanbanMcpServer`.
- A profile **role** field so a task assigned an orchestrator-role profile runs
  in orchestrator mode; the built-in `orchestrator` profile already exists.

Non-goals here (other Phase 5 specs): worktrees, attachments, multiple boards.

## Key decisions (from brainstorming)

1. **Scope = everything**, including `auto_decompose` — but the auto-trigger is a
   settings flag **defaulting off**, capped per tick, so it never silently spawns
   paid runs unless the user opts in.
2. **The original triage task completes and is the grouping parent.** The
   orchestrator run ends with `kanban_complete` → original `done`. Every child it
   creates is linked with the original as a parent, so the children promote
   immediately once the original is done, and the original's N/M child-progress
   pill tracks the whole graph. This resolves the parent-spec contradiction
   ("becomes parent of every child" vs. "promoted back to ready"): the original
   does **not** re-run; if synthesis is needed, the orchestrator creates an
   explicit synthesis child linked to the lanes.

## Architecture

### Run modes

Today every run is a `worker`. Generalise the run scope to a **mode**:
`work | decompose | specify`. Mode determines (a) the MCP toolset exposed to the
run, (b) the spawn prompt, and (c) the terminal semantics. The existing
`KanbanMcpServer` `McpRole = 'worker' | 'orchestrator'` is replaced by this mode.

### Profile role

Add `role: 'worker' | 'orchestrator'` to `WorkerProfile` (default `'worker'`).
The built-in `orchestrator` profile (`constants.ts`) gets `role: 'orchestrator'`.
A task assigned an orchestrator-role profile, when decomposed/specified, runs in
the corresponding orchestrator mode. The `settings-store` migration backfills
`role: 'worker'` onto existing saved profiles; `renderProfileMarkdown` is
unchanged by `role` (role governs Fleet-side mode selection, not the rune
profile file).

### Data model (schema v2, additive migration)

Bump `SCHEMA_VERSION` to `2`. The migration is additive (`ALTER TABLE … ADD
COLUMN`), guarded so re-running on a v2 DB is a no-op:

- `tasks.pending_mode TEXT` — `'decompose' | 'specify' | NULL`. Set by the drawer
  buttons / CLI / `auto_decompose`; cleared atomically when the dispatcher claims
  the task.
- `task_runs.mode TEXT NOT NULL DEFAULT 'work'` — so reclaim and the UI know what
  a run was.

Because the existing `migrate()` runs `SCHEMA_SQL` (all `CREATE TABLE IF NOT
EXISTS`) every open, the new columns are added via a versioned step: if
`user_version < 2`, run the `ALTER TABLE` statements (wrapped so an
already-present column is tolerated), then set `user_version = 2`.

### MCP toolsets (gated by the run token's mode)

`KanbanMcpServer.RunScope` gains `mode: 'work' | 'decompose' | 'specify'`
(replacing `role`). `tools/list` resolves the token → scope and returns the
toolset for that mode. `tools/call` enforces the same gate (a tool not in the
mode's set → `unknown tool`).

- **work** (unchanged): `kanban_show`, `kanban_complete`, `kanban_block`,
  `kanban_comment`, `kanban_heartbeat`.
- **decompose**: `kanban_show`, `kanban_list`, `kanban_create`, `kanban_link`,
  `kanban_unblock`, `kanban_comment`, `kanban_heartbeat`, `kanban_complete`.
  - `kanban_list({ status?, assignee? })` → board rows (read-only; an unknown
    assignee returns `[]`, matching Hermes, so the orchestrator can sanity-check
    a profile name).
  - `kanban_create({ title, body?, assignee?, priority?, parents? })` →
    `store.createTask(... status:'todo')`, then **auto-links the new task as a
    child of the orchestrator's own task** (the grouping-parent decision) and
    links each id in `parents` as an additional parent. Returns `{ task_id }`.
    Writes a `task_created` event.
  - `kanban_link({ parent_id, child_id })` / `kanban_unblock({ task_id })` →
    `store.addLink` / `store.setStatus('ready')` through the manual-status guard.
  - The run ends with `kanban_complete(summary)` → original `done` (run outcome
    `completed`); the dispatcher's promote phase then moves the `todo` children to
    `ready` (the original, now `done`, satisfies their parent link).
- **specify**: `kanban_show`, `kanban_update` *(new, terminal)*, `kanban_comment`,
  `kanban_heartbeat`.
  - `kanban_update({ title?, body })` applies the rewrite via
    `store.updateTask`, finishes the run `completed`, and returns the task to
    **`todo`** (not `done`, no fan-out). Writes a `task_updated` event and
    `unregisterRun`. This is the specify run's only terminal.

### Dispatcher

New **decompose phase**; tick order becomes
`reclaim → decompose → promote → claimAndSpawn`.

The decompose phase:

1. **Auto-arm (optional):** if `auto_decompose` is on, set
   `pending_mode = 'decompose'` on `triage` tasks that have `pending_mode IS
   NULL`, up to the remaining `maxDecompose` budget for this tick.
2. **Claim & spawn:** for each `triage` task with `pending_mode IS NOT NULL`, up
   to `maxDecompose` concurrent orchestrator runs:
   - Atomic CAS claim `triage → running` that **clears `pending_mode` in the same
     `UPDATE`** to prevent a double-spawn:
     `UPDATE tasks SET status='running', claim_lock=?, claim_expires=?,
      last_heartbeat_at=?, pending_mode=NULL, updated_at=? WHERE id=? AND
      status='triage' AND pending_mode IS NOT NULL AND (claim_lock IS NULL OR
      claim_expires<=?)`.
   - `store.startRun(taskId, 'orchestrator', null)` with `mode` = the captured
     `pending_mode`.
   - Register the MCP run with that mode; spawn `rune --profile orchestrator`
     with the mode-specific prompt.
   - Append a `spawned` event with `{ mode }`.

`maxDecompose` (default **1**) is a dedicated cap so orchestrator runs cannot
starve worker slots in `claimAndSpawn` (which keeps its own `maxInProgress`).
Orchestrator runs are counted by querying running tasks whose current run has
`mode != 'work'`.

**Reclaim** is extended: a dead/expired run whose `mode != 'work'` returns the
task to **`triage`** (re-armable) rather than `ready`, and counts toward the
failure limit like any run. `runningTasks()` reclaim already iterates all running
tasks; the branch keys off the current run's `mode`.

### Spawn (mode-specific prompt)

`buildWorkerInvocation` / `spawnRuneWorker` gain a `mode` field. Prompts:

- **decompose:** instructs the orchestrator to decompose the task into a child
  graph, names the available **worker-profile roster** (each profile's `name` +
  first line of `instructions` as a one-line description), and reminds it to
  assign each child to a real profile and `kanban_complete` when the graph is
  built. (Auto-injected guidance mirrors Hermes' "decompose, don't execute".)
- **specify:** instructs it to rewrite the task into a fuller spec and call
  `kanban_update` with the improved title/body, without creating child tasks.

The orchestrator profile is materialised to `.rune/profiles/orchestrator.md` like
any profile (existing `spawn-worker` path). Role/mode selects the prompt and MCP
toolset; the rune `--profile` flag still carries `orchestrator`.

## User-facing surfaces

### Drawer

`KanbanDrawer.tsx`: when `t.status === 'triage'` and `!running`, show **⚗
Decompose** and **✨ Specify** buttons. Each calls a new store action → IPC →
`KanbanCommands`. After the click the card shows a "queued for decompose…" /
"queued for specify…" affordance (driven by `pending_mode` on the task) until the
dispatcher's next tick flips it to `running`; the orchestrator run then appears in
the existing **Runs** list and live log tail. Orchestrator-role profiles appear in
the assignee dropdown naturally (they are ordinary profiles).

### KanbanCommands + IPC

Two new methods on the shared `KanbanCommands` layer (one store, no drift):

- `requestDecompose(id)` / `requestSpecify(id)` — `requireTask`, validate
  `status === 'triage'` (else `CodedError(BAD_REQUEST)`), set `pending_mode`,
  append a `decompose_requested` / `specify_requested` event.

New IPC channels `KANBAN_DECOMPOSE` / `KANBAN_SPECIFY` following the existing
`KANBAN_NUDGE` pattern (`ipc-channels.ts` → `ipc-api.ts` → `preload/index.ts` →
`ipc-handlers.ts` → command).

### CLI

`fleet-cli.ts`, symmetric with the Phase 4 verbs:
`fleet kanban decompose <id>` / `fleet kanban specify <id>` →
`kanban.decompose` / `kanban.specify` socket commands → same `KanbanCommands`
methods. `validateCommand` requires `id`; the positional `<id>` maps to
`args.id` in the existing kanban fixup block; `HELP_GROUPS.kanban` updated.
No orchestrator-only CLI surface — the MCP role is the worker-facing door.

### Settings

`KanbanSection.tsx`:

- **auto_decompose** toggle (default off) and **`maxDecompose`** number
  (default 1), persisted under `kanban.dispatcher`. Wired through the existing
  dispatcher `reconfigure` path (`DispatcherConfig` gains `autoDecompose` +
  `maxDecompose`).
- `ProfileEditor.tsx` gains a **role** selector (`worker` / `orchestrator`).
  `WorkerProfile`, `DEFAULT_SETTINGS`, and the `settings-store` merge/migration
  are updated; the migration backfills `role: 'worker'` on saved profiles.

## Data flow

```
drawer ⚗ / fleet kanban decompose <id>
  → KanbanCommands.requestDecompose(id)  (pending_mode='decompose', event)
dispatcher tick → decompose phase
  → CAS claim triage→running (clears pending_mode) → startRun(mode='decompose')
  → spawn rune --profile orchestrator  (decompose prompt, decompose MCP toolset)
orchestrator run
  → kanban_list (roster check) → kanban_create×N (children todo, child→original
    link + parents) → kanban_complete(summary)
  → original 'done'
next tick → promote: children whose parents (incl. original) are all done → ready
  → claimAndSpawn spawns the child workers

specify is the same up to spawn; the run calls kanban_update(body) → task 'todo'.
```

## Error handling

- Decompose/specify on a non-`triage` task → `CodedError(BAD_REQUEST)` from
  `KanbanCommands`; the CLI prints `Error: … (BAD_REQUEST)`, the drawer buttons
  are only shown for `triage` so the guard is defense-in-depth.
- Unknown task id → `NOT_FOUND`.
- Orchestrator run dies / times out → reclaim returns the task to `triage`,
  increments `consecutive_failures`; over `failure_limit` it auto-blocks
  (`gave_up`) like any task.
- A child assigned an unknown profile name sits in `ready` forever (Hermes
  behaviour — the dispatcher does not autocorrect). The decompose prompt names
  the real roster to avoid this; `kanban_list(assignee)` lets the orchestrator
  sanity-check.
- Kanban layer not ready (CLI before app up) → existing `UNAVAILABLE` path.

## Testing

- **`KanbanStore`** — `pending_mode` set/clear; `claimForDecompose` CAS
  (triage→running, clears `pending_mode`, exactly one winner of two concurrent
  claims); `task_runs.mode` persisted; schema-v2 migration adds columns and
  backfills (open a v1 DB, reopen, assert columns + `user_version=2`).
- **`KanbanDispatcher`** — decompose phase claims a flagged triage task and
  spawns with `mode='decompose'`; `maxDecompose` cap respected; `auto_decompose`
  arms triage tasks only when enabled and within cap; reclaim of a dead
  decompose run returns the task to `triage`.
- **`KanbanMcpServer`** — token→mode gates the toolset (`tools/list` differs per
  mode; a worker token cannot call `kanban_create`); `kanban_create` auto-links
  child→original and starts the child `todo`; `kanban_create` with `parents`
  adds the extra links; `kanban_update` (specify) rewrites the body and returns
  the task to `todo` without fan-out; each call writes a `task_events` row.
- **`KanbanCommands`** — `requestDecompose`/`requestSpecify` set `pending_mode`
  and reject a non-triage task.
- **`fleet-cli`** — `decompose`/`specify` arg parsing (positional→`id`) + help
  text. Pure (no socket).
- **Manual** — with the app + real Rune: a triage task → ⚗ Decompose → an
  orchestrator run fans out a 2–3 card graph → the original goes `done` → the
  children promote in dependency order and dispatch to workers. ✨ Specify
  rewrites a body and the task lands back in `todo`. `auto_decompose` off by
  default; when enabled it drains triage within the per-tick cap.

## Open questions

None at design time. Implementation may refine the exact decompose-prompt wording
(roster format) and whether `maxDecompose` should also be bounded by a global
concurrent-process ceiling shared with `maxInProgress`.
