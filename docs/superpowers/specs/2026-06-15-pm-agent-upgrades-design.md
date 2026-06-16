# PM Agent Upgrades — Event-Driven Turns, Authority & Standup Digest

**Date:** 2026-06-15
**Status:** Approved design
**Issue:** #233 (keystone of the autonomous-dev-team "team layer" epic #236)

## Problem

The PM agent today is a reactive chat box. It only acts when the human types
into PM chat (`pm-chat-service.ts:sendMessage`). It has no awareness of board
events as they happen, no scheduled cadence, and no authority to move the board
forward on its own — every decision routes back through a human prompt. The
board automates *execution* (the dispatcher) and *integration* (the integrate
autopilot, spec 2026-06-10), but the *management* layer is still entirely manual.

This spec upgrades the PM agent into an autonomous coordinator that:

- Wakes on board events (task completed, blocked, review-ready, verify-failed,
  feature shipped) — not just on human chat.
- Runs a scheduled standup digest summarizing what shipped, what's stuck, and
  what needs a human decision.
- Holds bounded board authority: it acts directly on safe moves and *proposes*
  risky/irreversible ones for one-click human confirmation.

## Goals

- The PM reacts to board activity on its own, with turns paced so it never
  thrashes (coalesced, single-flight, min-gap).
- Event turns and human chat turns share one serialized per-board session — they
  never run concurrently or corrupt the resume session.
- The PM can arm/unblock/reassign tasks directly (safe), and must propose
  merges/completes/archives (risky) for human approval.
- An optional per-board standup digest summarizes activity since the last digest.
- Everything is **off by default** behind a master toggle; turning it on is one
  switch (plus a one-click "daily 9am" preset for the digest).

## Non-goals

- Auto-merging feature PRs into main (still a human action / a PM *proposal*).
- A second long-lived process — the PM coordinator is an in-process `onEvent`
  consumer, not a daemon or a new server.
- Cross-board PM coordination — everything is board-scoped.
- Replacing the dispatcher's deterministic automation with LLM judgment; the PM
  sits *above* the dispatcher and nudges it, it doesn't replace its stages.
- Free-form board mutation from event turns — the PM acts only through the
  defined tool surface, never by editing the DB directly.

## Architecture

A new **`PmAutopilot`** coordinator becomes a *second consumer* of the existing
`KanbanStore.onEvent` callback (the first is `KanbanNotifier`). It decides
*when* the PM should take an event-driven turn; the actual turn runs through the
existing `pm-chat-service`, refactored so chat, event, and digest turns all
share one entry point and one serialized session per board.

```
KanbanStore.appendEvent(...)
        │  onEvent(event)
        ├──────────────► KanbanNotifier.enqueue   (existing — UI toasts)
        └──────────────► PmAutopilot.onEvent       (new)
                              │  filter → coalesce(2s) → min-gap(30s)
                              ▼
                    pm-chat-service.runTurn(boardId, prompt, origin)
                              │  per-board turn queue (single-flight;
                              │  user turns jump the queue)
                              ▼
                    rune --prompt … --resume <sessionId>
                              │  board-scoped MCP server (kanban tools)
                              ▼
                    safe tools act ·· risky tools → pm_proposals (await human)

PmAutopilot also owns a lightweight cron check for the standup digest:
        digestCron due  →  runDigestTurn(boardId, digestContext)
```

No new process, no new DB connection. `PmAutopilot` is constructed alongside the
dispatcher/notifier and wired to the same store.

## 1. Event-turn machinery (`PmAutopilot`)

`PmAutopilot` is a small class wired as a second `onEvent` consumer.

- **Master gate.** A per-board `pmAutopilotEnabled` config (default **false**)
  gates both event turns and the digest. Off → `onEvent` is a no-op.
- **Event filter.** Only a whitelist of board-meaningful event kinds trigger a
  turn: `task_completed`, `task_blocked`, `review_ready`, `verify_failed`,
  `feature_pr_ready`/`feature_shipped`. Noisy per-line run events are ignored.
- **Coalescing.** Events within `pmCoalesceWindowMs` (default **2000**) batch
  into a single turn, so a decompose that completes 8 subtasks at once yields
  one PM turn briefed on all 8, not 8 turns.
- **Min-gap.** At least `pmEventMinGapMs` (default **30000**) between event
  turns per board, so a busy board can't drive the PM into a hot loop. Events
  arriving inside the gap are folded into the next batch.
- **Single-flight.** A per-board turn queue (moved into `pm-chat-service`)
  serializes all turns. An event turn never runs while another turn (user or
  event) is in flight; a **user chat turn jumps the queue** ahead of pending
  event turns, because human input is higher priority and time-sensitive.

The coordinator wraps its `onEvent` body in try/catch so a failure never
propagates back into `appendEvent` (which must stay synchronous and reliable for
the store).

## 2. Turn entry points & briefing (`pm-chat-service` refactor)

Extract the turn body from `sendMessage` into:

```
runTurn(boardId, prompt, origin: 'user' | 'event' | 'digest'): Promise<void>
```

- `sendMessage(boardId, text)` → `runTurn(boardId, text, 'user')` (unchanged
  external behavior; adds queue priority).
- `PmAutopilot` → `runTurn(boardId, eventBriefing, 'event')`.
- digest cron → `runDigestTurn` → `runTurn(boardId, digestBriefing, 'digest')`.

`runTurn` owns: acquire the per-board queue slot, build the `rune` argv
(`--prompt body [--resume sessionId]`), enforce the 5-minute timeout, persist
the session id, release the slot. This fixes the latent concurrency bug noted in
the current `sendMessage` (no turn lock today).

**Event briefing** is built by `PmAutopilot` from the coalesced batch: a compact
structured prompt listing what changed (task ids, titles, kinds, relevant
guidance) and the PM's standing mandate to triage it. **Digest briefing** is
built by the digest path (§4).

**Origin log.** Each turn records its `origin` to a sidecar JSON next to
`pm-sessions.json` (not a DB table) so the renderer can distinguish
human-initiated from autopilot/digest turns in the chat transcript.

**Persona.** `buildPmAgentsMd()` (`pm-agents.ts`) gains an autopilot-mandate
section describing the PM's authority, the act-on-safe / propose-on-risky rule,
and the available tools — injected only when `pmAutopilotEnabled`.

## 3. Authority tools & proposal model (board-scoped MCP)

The board-scoped MCP server (`kanban-mcp-server.ts`, `PM_TOOLS`) gains a new
tier of tools. All mutations route through `KanbanCommands` (deterministic,
validated) — the PM never touches the DB directly.

**Auto-callable (safe — act immediately):**

- `kanban_arm_decompose(task_id)` — flag a task for the dispatcher's decompose
  stage.
- `kanban_arm_specify(task_id)` — flag a task for the specify stage.
- `kanban_unblock(task_id, guidance?)` — clear a block, optionally injecting
  guidance for the next run.
- `kanban_reassign(task_id, profile)` — move a task to a different worker
  profile.

**Confirmation-gated (risky / irreversible — propose only):**

- `kanban_propose(kind, target_id, rationale)` where `kind ∈
  { accept_review_and_merge, mark_feature_pr_ready, merge_feature,
  complete_task, archive_task }`.

A proposal writes a row to a new **`pm_proposals`** table (mirroring the existing
`feature_suggestions` `pending|accepted|dismissed` precedent, plus a `failed`
state). The renderer surfaces each pending proposal as an **Approve / Dismiss**
card in PM chat. On **Approve**, the corresponding `KanbanCommands` action runs
deterministically (not another LLM turn); on **Dismiss**, the row is marked
dismissed. Execution failure on approve marks the row `failed` and surfaces the
error to chat rather than silently dropping it.

**Guardrail.** `set_status` rejects a direct worktree-backed → `done`
transition (that path must go through `kanban_propose(complete_task)` so the
integrate autopilot and human confirmation aren't bypassed).

## 4. Standup digest

A board-level scheduled PM turn — distinct from task-level schedules
(`schedule.ts`); it is not a task.

- **Config.** Each board carries an optional `digestCron` (nullable string),
  gated by the same `pmAutopilotEnabled`. `PmAutopilot` owns the lightweight
  cron check. Default **null** (off); settings offers a one-click "daily 9am"
  preset.
- **Digest context.** When due, build a summary by querying `task_events` /
  `task_runs` / `features` since `last_digest_at`: tasks completed, tasks
  blocked, features shipped, verify/review failure patterns, and any still
  `pending` proposals.
- **Turn.** Call `runDigestTurn(boardId, digestContext)` → the PM produces a
  short standup (what shipped, what's stuck, what needs a decision), surfaced to
  chat plus one notification.
- **Watermark.** `last_digest_at` is stamped after a *successful* digest turn so
  the next digest covers only new activity.

## Config surface (per board)

| Key                   | Default | Meaning                                      |
|-----------------------|---------|----------------------------------------------|
| `pmAutopilotEnabled`  | `false` | Master switch for event turns *and* digest.  |
| `pmEventMinGapMs`     | `30000` | Minimum interval between event turns.         |
| `pmCoalesceWindowMs`  | `2000`  | Batch window for events into one turn.        |
| `digestCron`          | `null`  | Cron for the standup digest; null = off.      |

## Data model

Two additions; no migrations to existing tables.

- **`pm_proposals`** table — `id`, `board_id`, `kind`, `target_id`, `rationale`,
  `status (pending|accepted|dismissed|failed)`, `created_at`, `resolved_at`.
  Mirrors the `feature_suggestions` lifecycle pattern.
- **Turn-origin log** — sidecar JSON next to `pm-sessions.json` (not a DB
  table); the renderer overlays it on the chat transcript.

`last_digest_at` is a per-board value stored alongside the board's existing
config/state (no new table).

## Testing

- `PmAutopilot` unit tests: event filtering (whitelist), coalescing window,
  single-flight queue, min-gap enforcement, master-toggle-off → no turns.
- Briefing builder: coalesced events → expected structured prompt.
- Digest context builder: events since cutoff → expected summary input;
  `last_digest_at` stamping.
- Proposal lifecycle (pending → accepted/dismissed/failed), `set_status`
  worktree → done guardrail, and the four safe tools exercised via
  `KanbanCommands`.
- Turn-queue serialization: a user turn and an event turn never run
  concurrently; a user turn jumps ahead of pending event turns.

## Error handling

- `PmAutopilot.onEvent` wrapped in try/catch — never crashes the store or
  dispatcher.
- A failed event/digest turn (rune crash or timeout) is logged and dropped, not
  retried with the same briefing; board state re-surfaces the condition later.
- Proposal execution failure on Approve is surfaced to chat and marks the row
  `failed` rather than being silently lost.
- All new mutations route through `KanbanCommands`, inheriting its existing
  validation and sanitization.

## Rollout

All behavior is gated behind `pmAutopilotEnabled` (default off) and `digestCron`
(default null). With both at their defaults, the PM agent behaves exactly as it
does today (human-chat-only). This is the keystone for #234 (SDLC pipeline
templates) and #235 (retro/learning loop), which build on the event-turn and
proposal machinery defined here.
