# Retro/Learning Loop Design

**Date:** 2026-06-17
**Status:** Approved design, pre-implementation
**Issue:** #235 (autonomous-dev-team epic #236, builds on #233 PM event-driven turns)

## Problem

The PM has `MEMORY.md` and `docs/`, and per-task artifacts flow back from workers —
but nothing drives learning. No retro step exists, and the PM (reactive-only) never
reviews finished work unless asked. Repeated failure patterns (the same blocker
biting feature after feature, a profile that keeps producing rejected reviews) never
change board knowledge, so the team never gets smarter.

## Decision summary

- The retro is a **new PM turn origin (`retro`)**, fired by the existing #233
  autopilot — not a new worker role. The PM already owns `MEMORY.md`/`docs/`, knows
  the board, and the gap is framed as "the PM never reviews finished work."
- A feature "ships" when its PR flips to **`merged`**. The PR poller transitions the
  feature to `status='shipped'` (fire-once) and emits a `feature_shipped` event — a
  single terminal signal that also covers any future no-PR ship path.
- Distilled learnings land in **both** sinks, split by purpose: durable technical
  learnings → the #267 Learnings KB (semantically retrievable by future workers);
  board-process notes → `MEMORY.md` (read by the PM each turn).
- **Autonomy boundary:** learnings + `MEMORY.md` notes are auto-written (additive,
  reversible). Profile/prompt/doc changes are **suggestions in the retro summary
  only** — never auto-applied.
- **Scope:** single-feature analysis. Recurrence detection emerges from the retro
  reading existing `MEMORY.md` + searching the KB, not from new cross-feature
  analytics.

## Architecture

```
merged PR
  → pr-poller: feature.status='shipped' (fire-once) + appendEvent('feature_shipped')
  → KanbanStore.onEvent
  → PmAutopilot.onEvent: recognizes 'feature_shipped', schedules a RETRO turn
       (separate path from the coalesced triage briefing)
  → PmChatService.runTurn(boardId, retroPrompt, 'retro')
  → rune PM agent (board cwd: MEMORY.md + docs/ + kanban tools + kanban_learning_create)
       reads feature artifacts, searches KB + reads MEMORY.md for recurrence,
       writes learnings + MEMORY.md notes, emits a short retro summary
  → summary lands in the PM chat transcript
```

The retro reuses the entire #233 PM-turn machinery (board-scoped headless rune,
single-flight queue, transcript emit). It adds a distinct *origin*, a distinct
*prompt builder*, and one new *write tool*. It introduces no new run mode, worker
profile, or persona.

## Components

### 1. Trigger — `src/main/kanban/pr-poller.ts`

In `sweepFeatures`, after writing back the polled PR state: when
`res.state === 'merged'` and the feature is not already `shipped`/`archived`,
transition it and emit the terminal event.

```ts
// after setFeaturePrStatus(...)
if (res.state === 'merged' && feature.status === 'active') {
  this.store.updateFeature(feature.id, { status: 'shipped' });
  this.store.appendEvent(feature.id, null, 'feature_shipped', {
    prNumber: feature.prNumber ?? null
  });
}
```

- `feature.status === 'active'` is the fire-once guard: the next sweep that still
  sees `merged` finds `status='shipped'` and no-ops.
- `feature_pr_synced` continues to fire exactly as today (unchanged).
- **No-PR features** (purely local `quick_fix`) never reach `merged` via the poller,
  so they don't auto-trigger a retro today. This is acceptable: `status='shipped'` is
  the single signal, so a future no-PR ship path that sets it lights up retro for
  free. Documented, not built.

### 2. Recognition — `src/main/kanban/pm-autopilot.ts`

`feature_shipped` must NOT flow through the coalesced triage briefing (whose prompt
instructs the PM to "unblock stuck work / propose merges"). Add a separate path:

- `RETRO_KIND = 'feature_shipped'`.
- In `onEvent`, before the `TRIGGER_KINDS` buffering: if
  `event.kind === RETRO_KIND`, resolve the board, and (gated by
  `autopilotEnabled`) schedule a retro turn for that feature via a new
  `runRetro(boardId, featureId)` dep — bypassing the coalesce/min-gap buffer used by
  triage turns. (A retro is rare — one per shipped feature — and shouldn't be
  coalesced with unrelated triage events.)
- One new dep on `PmAutopilotDeps`:
  - `buildRetro: (featureId: string) => string | null` — builds the retro prompt
    (null if the feature/artifacts can't be resolved; the turn is then skipped).
    Built in `index.ts` where `kanbanStore` is in scope, mirroring how
    `buildBriefing`/`buildDigest` are wired in #233.
  - The retro turn is dispatched through the existing `runTurn(boardId, prompt,
    'retro')` dep — no new turn-dispatch API.

The same `autopilotEnabled` gate applies: with autopilot off, no retro fires (the
user can still ask the PM to retro manually in chat).

### 3. Retro briefing — `src/main/kanban/pm-retro.ts` (new)

```ts
export function buildRetroBriefing(
  feature: Feature,
  tasks: Task[],
  runsByTask: (taskId: string) => TaskRun[],
  eventsByTask: (taskId: string) => TaskEvent[]
): string
```

Assembles, per the shipped feature:

- Feature name + `qaVerdict`.
- For each member task: title, final outcome, the run `summary`, `reviewVerdict` +
  `reviewAttempts`, `verifyAttempts`, and any `blocked` / `verify_failed` /
  `gave_up` events (the friction signals).

The prompt then instructs the PM to:

1. **Search for recurrence first** — `learnings_search` the KB and re-read
   `MEMORY.md` for entries related to what it sees; recognize repeats.
2. **Write durable technical learnings** to the KB via `kanban_learning_create`
   (a gotcha, a discovered constraint, a pattern that worked).
3. **Append board-process notes** to `MEMORY.md` (recurring blockers, profile/prompt
   friction). When it recognizes a repeat, escalate the note ("this has now bitten N
   features").
4. **Emit a short retro summary**: what went well, what kept failing, and *suggested*
   profile/prompt/doc improvements — suggestions only, not applied.

### 4. Learnings write tool — `src/main/kanban/kanban-mcp-server.ts`

New tool in the **PM board scope** (not worker scope):

```ts
kanban_learning_create({ title, body, tags?, project?, feature_id? })
  → learningsStore.create({
      title, body, tags,
      sourceAgent: 'retro',
      sourceSessionId: feature_id ?? null,
      sourceProject: project ?? <board default project name>
    })
```

- **Idempotency** is primarily guaranteed by the fire-once trigger: a feature emits
  exactly one `feature_shipped` event (status guard), so the retro runs once per
  feature. As a second line of defense, the retro prompt tells the PM to pass the
  shipped feature's id as `feature_id`; the store's `create()` then returns the
  existing row when `(sourceSessionId, title)` matches, so a manually re-run retro
  doesn't pile up duplicates. `feature_id` is plumbed through the prompt text (which
  is per-feature), NOT through the turn-dispatch API — so `runTurn`'s signature is
  unchanged.
- Requires injecting a `LearningsStore` reference into the kanban MCP server's
  constructor deps.
- The tool is registered only for board scope; worker `toolsForMode` is unchanged, so
  workers cannot write learnings.

### 5. Supersession fix — `src/main/kanban/pm-chat-service.ts`

Today `enqueueTurn` drops all queued non-user turns when a new non-user turn arrives:

```ts
if (origin !== 'user') {
  const stale = c.queue.filter((q) => q.origin !== 'user');
  c.queue = c.queue.filter((q) => q.origin === 'user');
  ...
}
```

A queued retro would be silently dropped by a later `event`/`digest` turn, breaking
the "shipping → retro entry" guarantee. Change the predicate to preserve **`user`
and `retro`** turns; drop only `event`/`digest`:

```ts
const keep = (o: PmTurnOrigin) => o === 'user' || o === 'retro';
const stale = c.queue.filter((q) => !keep(q.origin));
c.queue = c.queue.filter((q) => keep(q.origin));
```

Retros enqueue at the back (not front — they're not urgent like user input), but are
never superseded.

### 6. Types — `src/shared/kanban-types.ts`

- `PmTurnOrigin` gains `'retro'`.
- `feature_shipped` is a new appendEvent kind. Event kinds are passed as free string
  literals elsewhere in the codebase (e.g. `'feature_pr_ready'`), so it is used as a
  string literal — no enum to extend. `RETRO_KIND = 'feature_shipped'` is the single
  named constant, defined in `pm-autopilot.ts` alongside `TRIGGER_KINDS`.

## Autonomy & safety

| Action | Mode |
| --- | --- |
| Write learning to KB | auto (additive, reversible) |
| Append note to `MEMORY.md` | auto (file history is the audit trail) |
| Profile/prompt/doc change | **suggestion in summary only** — never applied |
| Task/feature status change | never — retro is read-only over the board |

## Error handling

- A failed retro turn (rune crash, timeout) is logged and swallowed like other
  non-user turns. The feature is already shipped, so there's no board corruption — it
  just means no entry that time. The `status='shipped'` fire-once guard means no
  auto-retry; acceptable (a manual "re-run retro" affordance is out of scope).
- KB embedder offline is not a hard dependency: `create()` inserts the row and the
  existing launch backfill embeds it later. The KB degrades to keyword search.

## Testing

| Area | Test |
| --- | --- |
| `pr-poller` | merged → `status='shipped'` + `feature_shipped` event; second merged poll is a no-op (fire-once) |
| `pm-autopilot` | `feature_shipped` → retro turn dispatched with `'retro'` origin via the separate path, NOT bucketed into the triage briefing; non-trigger events unaffected; gated off when `autopilotEnabled` is false |
| `pm-retro` | `buildRetroBriefing` includes failing tasks, review verdicts, verify history, and the four PM instructions |
| `pm-chat-service` | a queued `retro` turn survives a subsequent `event` turn (not superseded); `event`/`digest` are still superseded by a new non-user turn |
| `kanban-mcp-server` | `kanban_learning_create` writes via `learningsStore` in board scope; absent from every worker `toolsForMode` |

## Out of scope

- Cross-feature aggregate analytics / trend dashboards.
- Auto-applying profile or prompt changes.
- A retro for features that ship without a GitHub PR (no current path sets
  `status='shipped'` for them; covered automatically if such a path is added later).
- A manual "re-run retro" command.
