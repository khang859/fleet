# Kanban Phase 4 — `fleet kanban` CLI Design

**Status:** approved (2026-05-30)
**Parent spec:** `docs/superpowers/specs/2026-05-30-kanban-board-design.md` (§ CLI, § Phasing item 4)

## Goal

Add a `fleet kanban …` command surface so the Kanban board is fully drivable
from the terminal — create/inspect/transition tasks, manage comments and
dependency links, dump a task's event log, nudge the dispatcher, and live-tail
board events — without opening the GUI.

## Architecture

The `fleet` CLI is already a thin Unix-socket client. `runCLI` in
`src/main/fleet-cli.ts` connects to `~/.fleet/fleet.sock`, sends a
newline-delimited `{ id, command, args }` request, reads one
`{ id, ok, data, error, code }` response, and auto-formats it (array → aligned
table, object → `key: value` lines, `--format json` for raw, `--quiet` to
suppress). The live server is `SocketSupervisor` → `SocketServer.dispatch()`
(the big `switch` that already handles `image.*`, `pi.*`, `annotate.*`,
`file.open`). The parallel `SocketApi`/`FleetCommandHandler` stack that supports
subscriptions is **dead code** — never instantiated in production — so `watch`
streaming is built on `SocketServer`, borrowing that subscribe/broadcast
pattern.

Phase 4 adds `kanban.*` commands to `SocketServer.dispatch()`, backed by a
single shared application layer so the CLI, the board IPC, and (future) other
front doors cannot drift.

### Components

1. **`src/main/kanban/kanban-commands.ts` — `KanbanCommands`** (new)
   The shared application layer over `KanbanStore` + `KanbanDispatcher`. One
   method per verb. Each method validates its arguments (throwing `CodedError`
   with `BAD_REQUEST` / `NOT_FOUND` on bad input, mirroring the `image.*`
   handlers), performs the store mutation, appends the matching `task_events`
   row, and returns plain serialisable data. This is the home for the business
   rules that today live in `kanban-ipc.ts`: the manual-status guard (reject any
   manual move **into or out of** `running`; only `MANUAL_STATUSES` =
   `triage|todo|ready|blocked|done|archived` allowed) and the per-mutation event
   append.

   Methods and their store mappings:
   - `create(args)` → `store.createTask(...)` (+ `task_created` event). Applies
     the same create-defaults getter (`workspaceKind`, `maxRuntimeSeconds`) the
     IPC layer uses.
   - `list({ status? })` → `store.listBoard()` (optionally filtered by status).
   - `show(id)` → `{ task, comments, runs, events, parents, children }` (the
     existing `TaskDetail` shape).
   - `assign(id, profile)` → `store.updateTask(id, { assignee })` (+
     `task_updated`).
   - `ready(id)` / `archive(id)` → `store.setStatus(id, 'ready'|'archived')`
     through the manual-status guard (+ `status_changed`).
   - `block(id, reason)` → `store.blockTask(id, reason)` (+ `status_changed`).
   - `unblock(id)` → `store.setStatus(id, 'ready')` through the guard (+
     `status_changed`).
   - `complete(id, result)` → `store.completeTask(id, result)` (+
     `status_changed`).
   - `comment(id, body)` → `store.addComment(id, 'human', body)` (+
     `comment_added`).
   - `link(parentId, childId)` / `unlink(parentId, childId)` →
     `store.addLink` / `store.removeLink` (+ `link_added` / `link_removed`).
   - `log(id)` → `store.listEvents(id)`.
   - `dispatch()` → `dispatcher.tick()`.

2. **`kanban-ipc.ts` — refactored to delegate.** The existing IPC handlers
   (`KANBAN_CREATE_TASK`, `KANBAN_SET_STATUS`, `KANBAN_ADD_COMMENT`,
   `KANBAN_ADD_LINK`, `KANBAN_REMOVE_LINK`, `KANBAN_NUDGE`, etc.) call the
   corresponding `KanbanCommands` methods instead of touching the store + event
   log directly. The renderer-facing IPC channels, payload shapes, and return
   values are unchanged; only the implementation moves behind `KanbanCommands`.
   This is what makes "one store, no drift" provable: CLI and board run the same
   code.

3. **`SocketServer` — `kanban.*` dispatch + subscription channel.**
   - Constructor gains an injected lazy getter `getKanban?: () => KanbanCommands
     | undefined`. The kanban store is created (`index.ts:740`) *after* the
     socket server starts (`index.ts:364`); a getter closure over the
     module-level binding resolves it at call time. `kanban.*` cases call
     `getKanban()` and throw `CodedError('Kanban not available', 'UNAVAILABLE')`
     when absent — the same shape used by the `image.*` cases.
   - New `kanban.*` cases route to the matching `KanbanCommands` method and
     return its data (one-shot, like every other command).
   - **`watch`:** a `kanban.watch` request registers the connected socket as a
     kanban subscriber and does **not** close it. A new
     `broadcastKanbanEvent(event)` method writes one JSON event line to each
     subscribed socket. Subscriber sockets are tracked in a `Set` and removed on
     `close`/`error`.

4. **`SocketSupervisor` — pass-through.** Threads `getKanban` into the
   `SocketServer` it constructs (alongside `imageService`/`annotateService`) and
   exposes `broadcastKanbanEvent(event)` that forwards to the current server
   instance (so it survives supervisor restarts, like the existing event
   relays).

5. **`fleet-cli.ts` — a dedicated `kanban` block + help.** A `group === 'kanban'`
   block in `runCLI` (peer of the `pi`/`annotate` blocks) handles:
   - **Positional → named mapping** the generic `parseArgs` can't express:
     `show <id>`, `block <id> --reason …`, `unblock|archive|ready|complete
     <id>`, `comment <id> <text>`, `link <parentId> <childId>`,
     `unlink <parentId> <childId>`, `log <id>`.
   - **Generic-path verbs:** `create` (flags only) and `list` (optional
     `--status`) can use the standard `kanban.<verb>` mapping and inherit the
     array→table / object→`key:value` / `--format json` / `--quiet` formatting.
     The block normalises them so output is consistent.
   - **`watch` streaming client:** connect, send the `kanban.watch` request,
     then print each streamed event line (text: `HH:MM:SS  <taskId>  <kind>  …`;
     `--format json`: the raw line) until the user interrupts (Ctrl-C) or the
     app closes. Uses its own socket lifecycle rather than the one-shot
     `FleetCLI.send`.
   - A `HELP_GROUPS.kanban` entry and a `kanban` row in `HELP_TOP`.

6. **`index.ts` — wiring.** After the store/dispatcher are constructed:
   construct `kanbanCommands = new KanbanCommands(store, dispatcher,
   getCreateDefaults)`; pass `() => kanbanCommands` into the `SocketSupervisor`;
   and forward `KanbanStore.onEvent` to `socketSupervisor.broadcastKanbanEvent`
   (in addition to the existing renderer forward) so `watch` streams live.

## Data flow

```
fleet kanban <verb> [args]
  → ~/.fleet/fleet.sock  ({ id, command: "kanban.<verb>", args })
  → SocketSupervisor → SocketServer.dispatch
  → getKanban().<verb>()  → KanbanStore (+ task_events row)
  ← { id, ok, data }  → runCLI formats → stdout

mutation → KanbanStore.onEvent
  → renderer IPC (unchanged)  AND  → supervisor.broadcastKanbanEvent
  → each `kanban.watch` subscriber socket receives one JSON event line
```

## Error handling

- Unknown task id → `CodedError(..., 'NOT_FOUND')`; missing required flag (e.g.
  `block` without `--reason`, `complete` without `--result`) →
  `CodedError(..., 'BAD_REQUEST')`. The server returns `{ ok: false, error,
  code }`; `runCLI` prints `Error: <message> (<code>)`.
- Manual move into/out of `running`, or a non-`MANUAL_STATUSES` target → the
  guard rejects it (no-op + warn, matching current IPC behaviour); the CLI
  reports the rejection rather than silently succeeding.
- Kanban layer not ready → `UNAVAILABLE`.
- App not running → existing `sendWithRetry` "Waiting for Fleet app to start…" /
  "Fleet app not running" path; `watch` reports the same and exits non-zero.

## Verbs (first cut)

`create`, `list`, `show`, `assign`, `ready`, `block`, `unblock`, `archive`,
`complete`, `comment`, `link`, `unlink`, `log`, `dispatch`, `watch`.

Examples:

```bash
fleet kanban create --title "Fix flaky test" --assignee default --priority 2
fleet kanban list --status ready
fleet kanban show t_abc123
fleet kanban assign t_abc123 --profile orchestrator
fleet kanban block t_abc123 --reason "needs design review"
fleet kanban unblock t_abc123
fleet kanban complete t_abc123 --result "merged in #210"
fleet kanban comment t_abc123 "rebased onto main"
fleet kanban link t_parent t_child
fleet kanban log t_abc123
fleet kanban dispatch
fleet kanban watch
fleet kanban list --format json
```

## Testing

- **`kanban-commands.test.ts`** — each verb against a real in-memory
  `KanbanStore` (sqlite, as in the existing store tests): create/list/show;
  every status transition incl. the running-status guard (reject) and
  `MANUAL_STATUSES` gating; comment; link/unlink; `log` returns appended events;
  `dispatch` ticks. Assert the correct `task_events` row is appended per
  mutation.
- **`fleet-cli.test.ts` (extend)** — kanban argument parsing: positional→named
  mapping for `show`/`block`/`unblock`/`archive`/`ready`/`complete`/`comment`/
  `link`/`unlink`/`log`; `create`/`list` flag handling; help text for
  `fleet kanban --help` and the top-level listing. Pure (no socket).
- **`kanban-watch` socket test** — modelled on `socket-subscribe.test.ts`:
  subscribe via `kanban.watch`, call `broadcastKanbanEvent`, assert the event
  line is delivered to the subscriber and that one-shot `kanban.*` commands
  still return-and-respond normally.
- **Manual** — with the app running: `create` a task from the CLI and see it
  appear on the board; `watch` in one terminal while mutating from another and
  see live lines; `block`/`unblock` round-trip; `link` a 2-task chain and watch
  promotion.

## Non-goals (Phase 4)

- `boards (list/create/switch/rename/rm)` — depends on multiple-boards (Phase 5).
- Worktree- or attachment-specific verbs (Phase 5).
- Re-using or reviving the dead `SocketApi`/`FleetCommandHandler` stack.
```
