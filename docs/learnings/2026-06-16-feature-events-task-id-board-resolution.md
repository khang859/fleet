# Feature-scoped kanban events store the feature id in `task_events.task_id`

**Date:** 2026-06-16
**Area:** kanban — events, PmAutopilot, digest

## What happened

While wiring `PmAutopilot` (PM agent event-driven turns, #233), `feature_pr_ready`
was added to the autopilot trigger whitelist. The event-turn pipeline resolves the
board for an incoming event via:

```ts
getBoardForTask: (taskId) => kanbanStore?.getTask(taskId)?.boardId ?? null,
```

`feature_pr_ready` (and other feature-level events) are appended with
`task_id = featureId` — a row in the `features` table, **not** `tasks`
(see `kanban-dispatcher.ts` `feature_pr_ready` emit, `kanban-commands.ts`).
So `getTask(featureId)` returned `null`, `getBoardForTask` returned `null`, and
`PmAutopilot.onEvent` silently dropped every `feature_pr_ready` event. The trigger
kind was registered but could never fire. Per-task review missed it; the final
whole-feature integration review caught it.

## Why it was easy to miss

`task_events.task_id` is overloaded: it holds a task id for task events and a
feature id for feature events. Nothing in the column name signals that. Any code
that resolves a board/title/name from an event's `taskId` by assuming it's a task
will silently no-op on feature events (no error — just `null` → dropped).

## Fix

Resolve through both tables, task first then feature:

```ts
getBoardForTask: (id) =>
  kanbanStore?.getTask(id)?.boardId ?? kanbanStore?.getFeature(id)?.boardId ?? null,
// title resolver likewise: getTask(id)?.title ?? getFeature(id)?.name ?? null
```

`KanbanStore.getFeature(id): Feature | null` exists; `Feature` exposes `boardId`
and `name`.

Also note: `listBoardEventsSince` JOINs `task_events` → `tasks` on `task_id`, so it
will never return feature events. The standup digest deliberately only buckets
task-level activity (completed/blocked/failures); feature-level events surface via
real-time PM event turns, not the digest. If a future change needs feature events
in the digest, the join must LEFT JOIN `features` too.

## Takeaway

When resolving anything from an event's `task_id`, remember it may be a feature id.
Check `tasks` and `features` (and any other entity that calls `appendEvent`).
