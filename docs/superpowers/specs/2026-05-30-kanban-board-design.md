# Kanban Board — Multi-Agent Task Board for Fleet (Rune workers)

**Status:** Approved (design)
**Date:** 2026-05-30
**Owner:** @khang859

## Goal

Port the Hermes Kanban feature into Fleet: a durable, SQLite-backed task board
that dispatches tasks to **Rune** workers running headlessly, coordinated
through a kanban toolset exposed over MCP. The board is a first-class Fleet tab
with columns, a card drawer, drag-and-drop, and a live event stream — plus a
`fleet kanban` CLI and a Settings section.

This brings Hermes' "durable message queue + state machine" collaboration shape
to Fleet, with Rune as the only agent: research triage, role pipelines
(researcher → writer → reviewer), engineering pipelines (decompose → implement
in worktrees → review → PR), and fleet work (one specialist over N subjects).

## Background

- **Fleet** is an Electron terminal multiplexer. Today it persists state as JSON
  via `electron-store` (no database). Agents normally run in *visible* terminal
  panes; pane lifecycle is tracked by `ActivityTracker`, and Rune panes use the
  `RUNE_READY_MARKER` + `~/.fleet/skills/fleet.md` injection plumbing.
- **Rune** (`github.com/khang859/rune`, vendored at `reference/rune`) is a Go
  coding agent. Its headless `--prompt` mode runs `agent.Run` agentically to
  completion through tool calls, then exits 0/1 — the right shape for a one-shot
  worker. **But** MCP servers and skills are only wired into the interactive TUI
  (`cmd/rune/interactive.go:43`), not the `--prompt` path (`cmd/rune/prompt.go`).
- **Hermes Kanban** is a durable SQLite board + a dispatcher loop that spawns
  worker OS processes per task, coordinated via `kanban_*` tools, comments,
  links, heartbeats, and retry/claim machinery, with a dashboard UI.

## Key decisions (from brainstorming)

1. **Dispatch model: headless background (Hermes-faithful).** A dispatcher in
   Fleet's main process spawns `rune --prompt` workers as detached child
   processes (not Fleet panes). Workers coordinate through a kanban toolset.
2. **Scope: full parity.** Multiple boards, worktree workspaces,
   auto-decompose/orchestrator, and attachments are all in scope, delivered in
   phases.
3. **Storage: SQLite (`better-sqlite3`).** WAL mode, atomic CAS claims,
   append-only event log. Mirrors Hermes' schema.
4. **Kanban toolset: one HTTP MCP server in the main process** with direct
   `KanbanStore` access. Each worker connects with a task-scoped URL/token.
5. **Worker runtime: extend Rune (headless MCP).** A small Rune-side change
   wires MCP + skills into `--prompt`. Tracked as rune#10 / rune#11 / rune#12.
6. **Assignee = a real Fleet "worker profile"** (name → model + skills + system
   prompt). Fleet owns the registry; the dispatcher materializes profiles as
   `~/.rune/profiles/*.md` so `rune --profile <name>` resolves them.

## Rune-side dependencies (separate repo, parallel work)

These are filed as issues on `khang859/rune` and block specific Fleet phases:

- **rune#10** — Headless mode: load MCP servers + skills in the `--prompt` path.
  Mirror `interactive.go` (`mcp.NewManager` + `mgr.Start` + skills loader);
  tools execute without an interactive approval gate in `--prompt`. *Blocks
  Phase 1 end-to-end.*
- **rune#11** — Overridable MCP config source: `RUNE_MCP_CONFIG` env override +
  project-local `<cwd>/.rune/mcp.json` merge (precedence: env → project-local →
  `~/.rune/mcp.json`). *Enables per-worker task scoping; blocks Phase 1.*
- **rune#12** — Named worker profiles: `rune --prompt --profile <name>` resolves
  model + skills (+ system prompt) from `~/.rune/profiles/*.md`. *Blocks Phase 3
  and the orchestrator in Phase 5.*

Until these land, Phase 1 can be verified against a stub worker.

## Architecture

Two repos:

### Rune (`reference/rune`)
The three changes above. After they land, a worker invocation is:
```
rune --prompt "work kanban task <id>: <title>\n\n<body>" \
     --profile <assignee> [--model <model_override>]
```
running to completion with the kanban MCP toolset available.

### Fleet (`src/`)

- **`KanbanStore`** (main) — `better-sqlite3`, WAL, schema + migrations. DB at
  `~/.fleet/kanban/kanban.db` (default board) or
  `~/.fleet/kanban/boards/<slug>/kanban.db`. All reads/writes funnel through
  here, so CLI / UI / MCP cannot drift ("three front doors, one store").
- **`KanbanDispatcher`** (main) — `setInterval` tick loop (default ~5s).
- **`KanbanMcpServer`** (main) — one long-lived HTTP MCP server, direct
  `KanbanStore` access, task-scoped by a per-run token in the URL.
- **Board tab** (renderer) — new `type: 'kanban'`, `<KanbanBoard>` component.
- **`fleet kanban …` CLI** — in `fleet-cli.ts`, routed over the socket API.
- **Kanban Settings section** — dispatcher config + worker-profile registry.

## Data model (SQLite)

Location: `~/.fleet/kanban/kanban.db` (default) /
`~/.fleet/kanban/boards/<slug>/kanban.db` (named boards). WAL mode.

**`tasks`** — `id` (TEXT PK), `title`, `body`, `assignee` (profile name),
`status`, `priority`, `tenant` (nullable), `workspace_kind`
(`scratch|dir|worktree`), `workspace_path`, `branch_name`, `model_override`,
`skills` (JSON), `idempotency_key`, `result`, `claim_lock`, `claim_expires`,
`worker_pid`, `current_run_id`, `last_heartbeat_at`, `consecutive_failures`,
`last_failure_error`, `max_runtime_seconds`, `max_retries`, `created_at`,
`updated_at`.

**`task_links`** — `(parent_id, child_id)` composite PK. Dispatcher promotes
`todo → ready` when all parents are `done`.

**`task_comments`** — `id`, `task_id`, `author`, `body`, `created_at`. The
inter-agent + human protocol; re-spawned workers read the full thread.

**`task_events`** — append-only audit log: `id`, `task_id`, `run_id`, `kind`,
`payload` (JSON), `created_at`. Drives the live board.

**`task_runs`** — per-attempt history: `id`, `task_id`, `profile`, `status`,
`worker_pid`, `started_at`, `ended_at`, `outcome`
(`completed|blocked|crashed|timed_out|spawn_failed|gave_up|reclaimed`),
`summary`, `metadata` (JSON), `error`.

**`task_attachments`** — `id`, `task_id`, `filename`, `stored_path`,
`content_type`, `size`, `created_at`.

**`boards`** — `slug` (PK), `name`, `icon`, `description`, `created_at`,
`archived_at`. (Each non-default board has its own DB file; this table is the
registry, stored in the default DB.)

**Statuses:** `triage → todo → ready → running → blocked → done → archived`.
`review` is a convention (a `blocked` task whose reason is prefixed
`review-required:`), not a separate column — matches Hermes. Hermes' `scheduled`
status is intentionally **out of the first cut** (no scheduled tasks requested);
easy to add later.

**Lifecycle:** a worker run ends in exactly one terminal state —
`kanban_complete` → `done` (run outcome `completed`), `kanban_block(reason)` →
`blocked`, or process exit without either → `crashed`. Crashed/reclaimed tasks
retry up to `max_retries`; after `consecutive_failures > failure_limit`
(default 2) the dispatcher auto-blocks with outcome `gave_up`.

## Dispatcher

A `setInterval` loop in the main process, default tick ~5s (configurable; far
tighter than Hermes' 60s gateway because this is a live desktop app). Each tick,
in order:

1. **Reclaim** — for any `running` task whose `claim_expires <= now` OR whose
   `worker_pid` is dead (`process.kill(pid, 0)` throws): close its `task_run`
   (outcome `crashed`/`reclaimed`), increment `consecutive_failures`, return the
   task to `ready` (or auto-block as `gave_up` once over `failure_limit`). A
   ~30s grace window protects freshly-spawned workers; a stale-heartbeat timeout
   catches wedged-but-alive PIDs.
2. **Promote** — any `todo` task whose parents are all `done` → `ready`.
3. **Claim & spawn** — up to `max_in_progress` (default **3**) concurrent:
   atomic CAS claim
   (`UPDATE … SET claim_lock=? WHERE id=? AND status='ready' AND (claim_lock IS NULL OR claim_expires<=now)`),
   create a `task_runs` row, prepare the workspace, spawn the worker.

The dispatcher sweeps **all boards** each tick and pins `FLEET_KANBAN_BOARD` per
worker so a worker can't see other boards.

### Worker spawn

Detached child via Node `child_process.spawn` (not a Fleet PTY/pane):
```
rune --prompt "work kanban task <id>: <title>\n\n<body>" \
     --profile <assignee> [--model <model_override>]
```
- **cwd** = resolved workspace dir.
- **env**: `RUNE_MCP_CONFIG` → a dispatcher-written `mcp.json` whose kanban entry
  is the task-scoped endpoint `http://127.0.0.1:<port>/mcp?run=<token>` (rune#11);
  plus `FLEET_KANBAN_TASK`, `FLEET_KANBAN_RUN`, `FLEET_KANBAN_BOARD`,
  `FLEET_KANBAN_WORKSPACE`.
- stdout/stderr → `~/.fleet/kanban/logs/<run>.log` (surfaced in the drawer).
- If the worker's prompt has attachments, an **Attachments** section listing
  each file's absolute path is appended so Rune reads them with its file tools.

### Workspace prep

- `scratch` — fresh tmp dir under the board's `workspaces/`; **deleted on
  completion**.
- `dir:<abs path>` — validated absolute path (relative rejected); **preserved**.
- `worktree` — reuse Fleet's `WorktreeService` to create `.worktrees/<id>/` on
  the task's branch; **preserved**.

### Heartbeat & TTL

Claim TTL ~15 min; `kanban_heartbeat` extends it. Because Rune's model turns can
be long, the **dispatcher also auto-extends** the claim while the PID is alive
*and* the run log is still growing — so a healthy-but-quiet worker isn't
reclaimed mid-turn even if the agent forgets to heartbeat. `max_runtime_seconds`
is enforced as a wall-clock kill → outcome `timed_out`.

## Kanban MCP server

One long-lived HTTP MCP server in the main process with direct `KanbanStore`
access. The `run` token in the URL resolves to `(task, run, role)`. Every tool
call writes a `task_events` row, which the board UI listens to.

- **Worker role** (scoped to one task): `kanban_show`, `kanban_complete`,
  `kanban_block`, `kanban_comment`, `kanban_heartbeat`.
- **Orchestrator role** (additionally): `kanban_list`, `kanban_create`,
  `kanban_link`, `kanban_unblock`.

## User-facing surfaces

### Board tab

New `type: 'kanban'` in the `Tab` union (mirrors how `'pi'` was added), opened
via `addKanbanTab()` in `workspace-store.ts`. Renders `<KanbanBoard>`:

- **Columns** L→R: Triage · Todo · Ready · Running · Blocked · Done (Archived
  behind a toggle). Running column can optionally group cards by assignee (lanes).
- **Card**: title, id, assignee badge, priority, tenant tag, comment/link
  counts, child-progress pill (N/M done), live status dot for running workers.
- **Drag-and-drop** between columns to change status (confirm on destructive
  moves).
- **Card drawer**: editable title/body/assignee/priority (markdown-rendered body
  + result), dependency editor (parent/child chips), status action buttons
  (→ready / block / unblock / complete / archive), comment thread (Enter to
  post), run history (outcome, profile, duration, summary, metadata),
  attachments (upload/download/remove), and a **live worker log tail** for
  running tasks. Triage cards get **⚗ Decompose** / **✨ Specify** buttons.
- **Toolbar**: search, tenant filter, assignee filter, archived toggle, board
  switcher (when >1 board), **Nudge dispatcher** button.
- **Live updates**: renderer subscribes via a new IPC channel relaying
  `task_events` from the main `EventBus` — no websocket needed (in-process).

### IPC

New `window.fleet.kanban.*` surface following the existing pattern
(`ipc-channels.ts` → `ipc-api.ts` → `preload/index.ts` → `ipc-handlers.ts`):
`listBoard`, `getTask`, `createTask`, `updateTask`, `bulk`, `addComment`,
`addLink`/`removeLink`, `specify`, `decompose`, `nudgeDispatch`,
`uploadAttachment`/`removeAttachment`, `listProfiles`, plus an `onEvent`
listener for the live stream. Handlers call into `KanbanStore` /
`KanbanDispatcher`.

### CLI

`fleet kanban …` in `fleet-cli.ts`, symmetric to `fleet pi` / `fleet rune`,
routed over the socket API. First-cut verbs: `create`, `list`, `show`,
`complete`, `block`, `unblock`, `archive`, `assign`, `link`/`unlink`, `comment`,
`watch`, `log`, `boards (list/create/switch/rename/rm)`, `dispatch`. Same
`KanbanStore` layer behind it.

### Settings

New **Kanban** section (`settings/kanban/KanbanSection.tsx`; add to
`SettingsNav` union + `SettingsTab` route; placed near Rune): dispatcher
interval, `max_in_progress`, default workspace kind, default `max_runtime`, and
the **worker-profile registry editor** (name → model + skills + system prompt).
Fleet owns these; the dispatcher materializes them as `~/.rune/profiles/*.md`
so `rune --profile` resolves them. The registry is the source of truth for the
board's assignee dropdown.

## Orchestrator / auto-decompose

A `triage` task can be expanded into a child-task graph. When `auto_decompose`
is on (capped per tick) — or via the drawer's **⚗ Decompose** button — the
dispatcher spawns an orchestrator run: `rune --prompt --profile orchestrator`
with the **orchestrator MCP role**. It receives the rough task body + the
worker-profile roster (names + descriptions) and calls
`kanban_create`/`kanban_link` to build the graph. The original task becomes
parent of every child and is promoted back to `ready` when the graph completes.
**✨ Specify** is the lighter single-task version (rewrite one task into a fuller
spec, no fan-out). The `orchestrator` profile is a built-in entry in the profile
registry (model + a system prompt teaching the kanban-orchestrator workflow).

## Multiple boards

Registry in the default DB's `boards` table. Each non-default board gets its own
DB file at `~/.fleet/kanban/boards/<slug>/kanban.db` plus its own `workspaces/`,
`logs/`, `attachments/`. Slug validation matches Hermes (lowercase alnum +
`-`/`_`, 1–64 chars, must start alphanumeric, no traversal). Board switcher in
the toolbar; the dispatcher pins `FLEET_KANBAN_BOARD` per worker. Cross-board
links are disallowed.

## Attachments

Drawer upload (25 MB cap), stored under `…/attachments/<task_id>/`. The worker's
prompt includes an **Attachments** section listing each file's absolute path so
Rune reads them directly with its file tools. Download/remove from the drawer
(removing deletes both the row and the on-disk file).

## Worktrees & review convention

`workspace_kind: 'worktree'` reuses Fleet's `WorktreeService` to create
`.worktrees/<id>/` on the task's branch; preserved on completion. Code tasks
follow the Hermes convention: the worker **blocks** with a `review-required:`
reason and drops structured metadata (changed files, diff/PR url, test counts)
into a comment first. The board surfaces these for human review; `unblock`
re-spawns the worker with the full comment thread for follow-ups.

## Phasing

One spec; milestoned plan.

1. **Core** — `KanbanStore` (SQLite/schema/migrations) + `KanbanDispatcher`
   (reclaim/promote/claim/spawn) + `KanbanMcpServer` (worker tools) + scratch
   workspaces. Verifiable headless end-to-end with a stub worker, then with real
   Rune once rune#10/#11 land.
2. **Board UI** — tab, columns, drawer, drag-drop, live event stream, IPC.
3. **Profiles & settings** — registry editor + `--profile` materialization
   (needs rune#12) + worker-profile assignment.
4. **CLI** — `fleet kanban …` over the socket API.
5. **Advanced** — multiple boards, worktrees, attachments,
   orchestrator/auto-decompose.

## Testing

- **`KanbanStore`** — unit tests for schema migration, atomic claim CAS (two
  concurrent claims, exactly one wins), dependency promotion, retry/failure-limit
  transitions, event-log append.
- **`KanbanDispatcher`** — reclaim of dead PID / expired claim; promote on
  parents done; concurrency cap respected; auto-block after failure limit;
  wall-clock timeout. Use a stub worker (a script that exits / sleeps / calls the
  MCP) to avoid depending on a live model.
- **`KanbanMcpServer`** — token→task scoping; worker vs orchestrator tool gating;
  each call writes a `task_events` row.
- **CLI** — `fleet kanban` argument parsing unit tests in `fleet-cli.test.ts`.
- **Store action** — `addKanbanTab` unit test.
- **Manual** — create a task in the board, watch it dispatch to a real Rune
  worker (post rune#10/#11), see it call `kanban_complete`, and confirm the card
  moves to Done with a result; block + unblock round-trip; a 3-task dependency
  chain promotes in order; multiple boards isolate; a worktree task produces a
  reviewable diff.

## Non-goals (first cut)

- Scheduled tasks (Hermes' `scheduled` status / scheduler).
- Notifications bridge (Slack/Telegram/Discord subscriptions).
- Visible-pane workers (chosen model is headless background processes).
- Running non-Rune CLIs as worker lanes (Rune is the only lane).
- Cross-board task links.

## Open questions

None at design time. Implementation may surface choices about exact MCP
transport details (token vs header scoping), the precise per-run heartbeat
auto-extend heuristic, and column copy/labels.
