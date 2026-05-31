# Kanban Swarm — Topology Helper

**Status:** Approved (design)
**Date:** 2026-05-31
**Owner:** @khang859

## Goal

Add a one-shot, deterministic (no-LLM) helper that writes a **swarm task graph**
into the existing kanban kernel: a root/blackboard card, N parallel worker cards,
a verifier card gated on all workers, and a synthesizer card gated on the
verifier. It is launchable from three surfaces — the dashboard (a modal), the CLI
socket (`fleet kanban swarm …`), and an MCP tool (`kanban_swarm`) so an
orchestrator worker can spin one up itself.

This ports hermes's `kanban swarm` (`reference/hermes-agent/hermes_cli/kanban_swarm.py`)
into Fleet. The whole point of a swarm helper is that it is **deterministic and
LLM-free**: unlike `decompose`, it does not call a model to produce a graph — it
writes a fixed topology directly. It introduces **no new scheduler**; the existing
dispatcher promotes and spawns the cards exactly as it does for any linked graph.

## Background

- **Every primitive already exists.** `KanbanStore` has `createTask`,
  `addLink`, `completeTask`, `addComment`, `listComments`, `getTask`, and the
  dispatcher's `promote()` moves a `todo` task to `ready` when all its parents are
  settled. A swarm is just a particular arrangement of these.
- **The dispatcher gates on parent status.** `promotableTodoTasks()`
  (`src/main/kanban/kanban-store.ts`) promotes a `todo` task only when **no**
  parent has a non-settled status. This is the gating mechanism the verifier
  (parents = all workers) and synthesizer (parent = verifier) rely on.
- **Workers must be `todo` with a non-null assignee.** `claimAndSpawn()` iterates
  `readyTasks()`, whose query is `status='ready' AND assignee IS NOT NULL`. A
  `ready` card with a null assignee is never spawned. The clean, uniform approach
  is to create **every** swarm card (workers, verifier, synthesizer) as `todo`;
  the root is completed first, so the workers are immediately promotable on the
  next tick. Every worker must carry a worker-role assignee or it strands.
- **The blackboard is not reachable with today's MCP tools.** `kanban_show` and
  `kanban_comment` (`src/main/kanban/kanban-mcp-server.ts`) are hard-scoped to the
  worker's **own** card (`scope.taskId`) with no target-task argument. A worker
  therefore cannot read or post to the root, and the synthesizer (a separate card
  with a separate workspace) has no channel to the workers' results. The
  blackboard is the only cross-card data channel, so making it reachable requires
  **new MCP tooling**.
- **The dispatcher is single and global, capped at 3.** `maxInProgress` defaults
  to 3 and the dispatcher's queries are not board-scoped. A swarm therefore cannot
  fork-bomb (50 workers serialize 3-at-a-time), but it does monopolize scheduling
  across all boards while it runs.
- **Phase 7 notifications already cover `blocked` and `failed`.** A swarm worker
  that blocks or gives up already fires an OS notification through the existing
  `KanbanNotifier`, so a stalled swarm is not silent without new work.

## Architecture

A pure helper module builds the graph through existing store methods. A single
`KanbanCommands.createSwarm()` method wraps it (defaults, board scoping,
validation, post-commit events). Three thin adapters call that one method, which
preserves the existing "single application layer so the three front doors can't
drift" invariant documented in `kanban-commands.ts`.

```
dashboard modal ─┐
CLI `swarm` verb ─┼─▶ KanbanCommands.createSwarm(input)
MCP kanban_swarm ─┘        │  (defaults, board, validation, events post-commit)
                           ▼
                  kanban-swarm.createSwarm(store, input)   [pure, in a transaction]
                           │
          ┌────────────────┼─────────────────────────────────┐
          ▼                ▼                                  ▼
   root (→ done,      workers ×N (todo,                verifier (todo,
   blackboard)        parents=[root],                  parents=workerIds)
                      assignee required)                       │
                           │                                   ▼
                           └──────────────────────────▶ synthesizer (todo,
                                                          parents=[verifier])
```

### Unit: pure helper (`src/main/kanban/kanban-swarm.ts`)

Mirrors `kanban_swarm.py`. No Electron, IPC, or React dependencies; operates only
through injected `KanbanStore` methods.

- `BLACKBOARD_PREFIX = '[swarm:blackboard] '` (trailing space, exact hermes
  parity).
- `interface SwarmWorkerSpec { profile: string; title: string; body: string; skills: string[]; priority?: number; maxRuntimeSeconds?: number | null }`
- `interface SwarmInput { goal: string; workers: SwarmWorkerSpec[]; verifierAssignee: string; synthesizerAssignee: string; boardId?: string; tenant?: string | null; priority?: number; rootTitle?: string; verifierTitle?: string; synthesizerTitle?: string; createdBy?: string }`
- `interface SwarmCreated { rootId: string; workerIds: string[]; verifierId: string; synthesizerId: string }`
- `createSwarm(store, input): SwarmCreated` —
  1. Create root: `title = rootTitle ?? "Swarm: <first 80 chars of goal>"`, body
     describes the swarm + goal, `skills` omitted, status defaults then immediately
     `completeTask(rootId, summary)` so it is `done`. Root completion records a
     marker so it is identifiable as a swarm root (`kind: 'kanban_swarm_v1'`,
     `goal`, `workerCount`) — stored both in the completion result/summary and as
     the canonical `topology` blackboard entry.
  2. Create each worker: `status='todo'`, `parents=[rootId]`,
     `assignee=spec.profile` (required, non-null), `skills=spec.skills`,
     `body = (spec.body || spec.title) + swarmContext`.
  3. Create verifier: `status='todo'`, `parents=workerIds`,
     `assignee=verifierAssignee`, `skills=['requesting-code-review']`,
     body instructs it to review all worker/blackboard output and **complete only
     when satisfied, otherwise block with the exact missing work** (so a problem
     withholds the synthesizer).
  4. Create synthesizer: `status='todo'`, `parents=[verifierId]`,
     `assignee=synthesizerAssignee`, no skill, body instructs it to synthesize the
     verified outputs.
  5. `postBlackboardUpdate(store, rootId, author=createdBy, key='topology', value={...SwarmCreated, goal})`.
- `swarmContext(rootId, goal): string` — the `## Swarm protocol` body suffix:
  names the root id as the shared blackboard, instructs the card to read
  sibling/parent handoffs and post cross-card notes to the root **via the
  `kanban_swarm_read` / `kanban_swarm_post` tools**, and states the goal.
- `postBlackboardUpdate(store, rootId, author, key, value): TaskComment` — appends
  `BLACKBOARD_PREFIX + JSON.stringify({key, value})` as a comment on the root.
- `latestBlackboard(store, rootId): Record<string, unknown>` — folds the root's
  blackboard comments, last-write-wins per key, and adds `_authors` mapping each
  winning key to its comment author. Non-prefixed or unparseable comments are
  skipped.
- `parseWorkerArg(raw): SwarmWorkerSpec` — parses `profile:title[:skill,skill]`;
  body defaults to the title; throws on missing profile/title.

### Unit: `KanbanStore` changes (`src/main/kanban/kanban-store.ts`)

- **Expose `transaction<T>(fn: () => T): T`** wrapping better-sqlite3's
  transaction so `createSwarm` builds the whole graph atomically. A failure
  (e.g. a bad assignee discovered mid-build) rolls back — no orphaned partial
  graph. Events are **not** emitted inside the transaction; the command layer
  emits them after commit.
- **Gate change:** `promotableTodoTasks()` currently excludes a `todo` task if any
  parent has `status != 'done'`. Change the predicate to treat a parent as settled
  when its status is **`done` or `archived`** (`status NOT IN ('done','archived')`),
  matching hermes's `all(p in ('done','archived'))`. This lets a user release a
  stalled swarm by archiving a failed/blocked worker, and is a sensible general
  improvement (an archived parent is no longer active work). Covered by a
  regression test asserting both swarm and non-swarm graphs promote correctly.

### Unit: command layer (`KanbanCommands.createSwarm`)

The single entry point for all three surfaces.

- Applies `getCreateDefaults()` (workspace kind, max runtime) to every card, the
  same way `create()` does.
- Enforces the worktree `repoPath` guard for every worker (don't bypass it by
  writing to the store directly).
- Board scoping: all cards inherit one `boardId` (the input board, else the
  active/default board).
- Validation (throws `CodedError(..., 'BAD_REQUEST')`): `workers.length >= 1`;
  `verifierAssignee` and `synthesizerAssignee` non-empty; each worker's assignee
  resolves to a known worker-role profile (an unknown assignee would spawn-fail
  and deadlock the gate); a sane upper cap on N (e.g. 20) to avoid monopolizing the
  global dispatcher — excess is rejected with a clear message rather than silently
  truncated.
- Runs `kanban-swarm.createSwarm` inside `store.transaction(...)`, then **after
  commit** emits a `swarm_created` event on the root and the per-card
  `task_created` events (so the renderer's event-driven board refresh fires).
- Returns `SwarmCreated`.

### Unit: new MCP tools (`src/main/kanban/kanban-mcp-server.ts`)

The blackboard-reachability fix. So the server can resolve and post to the root,
it gains access to the swarm helper (and, for the creation tool, to
`KanbanCommands`).

- `kanban_swarm_read({ root })` — returns `latestBlackboard(store, root)`. `root`
  is the id injected into the card's body by `swarmContext`. Validated to be a
  swarm root (`kanban_swarm_v1` marker) before reading.
- `kanban_swarm_post({ root, key, value })` — `postBlackboardUpdate(store, root,
  author=<this card's assignee/id>, key, value)`. Same root validation.
- These are added to the worker toolset (every swarm card is a worker run) and
  registered in `handleToolCall`.
- Optional creation tool `kanban_swarm({ goal, workers, verifier, synthesizer })`
  in the orchestrator (decompose) toolset, routed through
  `KanbanCommands.createSwarm` so defaults/board/validation apply. Requires the
  MCP server to hold a `KanbanCommands` reference (today it holds only a
  `KanbanStore`).

### Unit: CLI socket verb (`src/main/socket-server.ts`)

A `swarm` case in the kanban command dispatch:
`fleet kanban swarm <goal> --worker profile:title[:skill,skill] (repeatable) --verifier P --synthesizer P [--board slug]`.
Parses args (reusing `parseWorkerArg`), calls `commands.createSwarm`, emits the
`state-change 'kanban:changed'` the other CLI kanban verbs emit, and prints the
`SwarmCreated` ids (with `--json` for machine output). Follows the **code** form
of hermes's CLI (`--worker`, repeatable), not the stale `--workers` doc example.

### Unit: IPC + preload + dashboard modal

- New channel `KANBAN_CREATE_SWARM` in `src/shared/ipc-channels.ts`; main handler
  calls `commands.createSwarm`.
- Preload: `kanban.createSwarm(input): Promise<SwarmCreated>`.
- Renderer: a **Swarm modal** opened from a board toolbar button — a goal field,
  add/remove worker rows (profile + title + optional skills), and verifier &
  synthesizer profile pickers (populated from the configured worker profiles). On
  success the board refreshes via the existing event path; no manual reload.

## Data flow

1. A surface calls `KanbanCommands.createSwarm(input)`.
2. The command validates, applies defaults/board, and runs the pure helper inside
   one store transaction: root created and completed (`done`, blackboard seeded
   with `topology`); workers, verifier, synthesizer created `todo` with their
   gating links and protocol-suffixed bodies.
3. After commit, the command emits `swarm_created` + per-card `task_created`. The
   renderer refetches the board; the CLI/MCP return the ids.
4. On the next dispatcher tick, `promote()` moves the workers (parents = the done
   root) to `ready`; `claimAndSpawn()` spawns up to `maxInProgress` of them.
5. Workers read/post the shared blackboard via `kanban_swarm_read` /
   `kanban_swarm_post` against the root id in their body. As each worker completes,
   the verifier becomes promotable once **all** workers are settled (done or
   archived).
6. The verifier reviews the blackboard, then completes (→ promotes synthesizer) or
   blocks (→ withholds synthesizer; fires a Phase 7 `blocked` notification).
7. The synthesizer, promoted when the verifier is `done`, reads the verified
   blackboard and produces the final deliverable.

## Error handling

- **Worker fails or blocks (stall):** the verifier's gate is not satisfied, so it
  (and the synthesizer) stay `todo`. This is intentional human-in-the-loop
  behavior, faithful to hermes. It is **not silent**: the blocked/gave-up worker
  fires an existing Phase 7 notification and shows on the board. The user releases
  the swarm by completing or **archiving** the failed worker (the gate counts
  archived as settled).
- **Partial build failure:** the store transaction rolls back; no orphaned graph.
- **Unknown / non-worker assignee:** rejected up front by command validation
  (prevents a spawn-fail deadlock).
- **Worktree worker without repoPath:** rejected by the worktree guard in the
  command layer.
- **Empty workers / missing verifier or synthesizer / N over cap:** rejected with
  a `BAD_REQUEST` message.
- **Blackboard tool called with a non-swarm-root id:** rejected by the root marker
  check.

## Testing

- **Pure helper** (`src/main/kanban/__tests__/kanban-swarm.test.ts`): topology
  shape (root done; workers `todo` with `parents=[root]` and non-null assignee;
  verifier `parents=workerIds`; synthesizer `parents=[verifier]`); blackboard
  round-trip (prefix, `{key,value}`, last-write-wins, `_authors`); `topology`
  entry present; `parseWorkerArg` valid + error cases; body suffix injected and
  names the root id.
- **Transaction rollback:** a `createSwarm` that throws partway (stubbed store
  failure) leaves zero rows — assert no root/workers/links persisted.
- **Gate change** (store/dispatcher test): a `todo` task with a `done` parent and a
  `todo` task with an `archived` parent both promote; a task with a `blocked`
  parent does not — for both swarm and ordinary graphs.
- **Command layer:** defaults applied; board scoping; validation errors (N<1,
  missing verifier/synthesizer, unknown assignee, worktree-without-repo, N over
  cap); `swarm_created` + `task_created` emitted **after** commit.
- **CLI parse:** `swarm <goal> --worker a:t1 --worker b:t2:skill --verifier v
  --synthesizer s` produces the right `SwarmInput`; `--json` output shape.
- **MCP tools:** `kanban_swarm_read` returns merged blackboard; `kanban_swarm_post`
  appends a prefixed comment; both reject a non-swarm-root id; the optional
  `kanban_swarm` creation tool routes through the command layer.
- **Manual:** create a 3-worker swarm from the modal; confirm workers spawn (3-wide),
  post to the blackboard, the verifier wakes after all workers, and the synthesizer
  wakes after the verifier; block one worker and confirm the swarm stalls with a
  notification and that archiving the worker releases the verifier.

## Non-goals (this cut)

- **Idempotency / re-run recovery.** Fleet has no idempotent-create infrastructure
  (a duplicate `idempotency_key` hits a UNIQUE index and throws). Re-running a
  swarm creates a fresh graph. Documented; a lightweight client-side guard is a
  possible later enhancement.
- **Unread-badge coalescing for swarm completion.** Each completed card is a real
  task update, so the badge increments per event (the OS toast already coalesces
  the burst). Accepted as-is for v1.
- **N-of-M / quorum gating** and **configurable graph shapes** beyond the fixed
  root → workers → verifier → synthesizer topology.
- **Board-scoped dispatcher concurrency.** The global cap of 3 is unchanged; a
  running swarm shares it with all boards.

## Open questions

None at design time. Implementation may choose the exact modal layout, the
upper-bound value for N (proposed 20), and the precise body copy for the
root/verifier/synthesizer cards.
