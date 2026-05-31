# Kanban: orchestrator-assigned work tasks die and "give up"

## Symptom

A rune worker is spawned for a task, exits almost immediately, gets respawned, and
after 2 attempts the dispatcher logs `task gave up {failures:2}` and the task lands in
`blocked`. Reported as "the file attachments system broke the worker" — attachments were
a red herring; they were just what was being tested.

```
09:35:03 [kanban-spawn] spawned rune worker {taskId:024a1988, pid:544435}
09:35:37 [kanban-spawn] spawned rune worker {taskId:024a1988, pid:544449}
09:36:10 [kanban-dispatcher] task gave up {taskId:024a1988, failures:2}
```

## Root cause

`rune --prompt <text>` runs **one turn and exits**. For a `work` run to count as
successful, the agent must call `kanban_complete` (or `kanban_block`) during that turn —
otherwise `KanbanDispatcher.reclaim()` sees the exited pid (`isAlive` false, no recent
heartbeat), records a failure, and after `failureLimit` (2) calls `giveUp`, which sets
status `blocked`.

The instruction to call `kanban_complete` comes **only from a worker-role profile
persona** (`src/shared/constants.ts` default `default`/worker profile). The work-mode
prompt in `spawn-worker.ts` `buildPrompt` does *not* include it — unlike `decompose`
("call kanban_complete with a one-line summary") and `specify` ("call kanban_update").

The failing task was assigned to the **`orchestrator`** profile but dispatched in
**`work`** mode (`claimAndSpawn` hardcodes `mode: 'work'`; a task only runs in decompose
mode if armed with a `pendingMode`). The orchestrator persona says *"do not implement the
work yourself"* and never mentions `kanban_complete`, so the worker answered and exited
without completing → reclaimed as a dead worker → gave up.

Confirmed against the runtime DB: `work` + `default` profile → `completed`; `work` +
`orchestrator` profile → `reclaimed`/`gave_up`; `decompose` + `orchestrator` →
`completed`.

## Fix

`resolveWorkProfile(profiles, assignee)` in `spawn-worker.ts`: a work run uses the
assigned profile only if its role is `worker`; otherwise it falls back to the first
worker-role profile so the `kanban_complete` instruction always reaches the agent.
`index.ts` calls it in the `work` branch and `log.warn`s when it overrides an explicit
assignee.

Subtleties caught in review:
- The fallback must be **role-filtered**. An earlier `?? find(p => p.name === 'default')`
  clause was only reachable when no worker-role profile existed, so it could *only*
  return a non-worker `default` and re-introduce the bug. Removed it — `find(role ===
  'worker')` already matches a worker named `default`.
- `fellBack` keys off `assignee != null`, not the resolved profile, so a typo'd/deleted
  assignee name still logs the substitution warning.

## Known limitation (not fixed)

If the user deletes *all* worker-role profiles, `resolveWorkProfile` returns `null` and
`buildWorkerInvocation` still passes `--profile <original-assignee>` to rune. The shipped
defaults always include a worker profile, so this only occurs in a deliberately broken
config.
