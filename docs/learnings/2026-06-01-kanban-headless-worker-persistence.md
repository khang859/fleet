# Kanban headless workers: stop "going quiet" from looking like a crash

## Symptom (issue #210)

Kanban worker cards repeatedly failed with `last_failure_error = "worker pid not alive"`
and landed in `blocked` with `result = "gave-up: worker pid not alive"`. Run history
showed 5–7 reclaimed runs per card. The worker logs showed the agent did real work, then
**ended its turn with a question** ("If you approve this plan, I'll implement it…") instead
of calling `kanban_complete`/`kanban_block`.

## Root cause

`rune --prompt` runs one agentic turn: its loop (`internal/agent/loop.go`) ends the moment
the model emits text with **no tool call**. That "no tool call" branch *is* the
"asked a question and stopped" event. In a headless kanban worker no human answers, so the
process exits. The dispatcher's `reclaim()` saw the dead pid, recorded a failure, retried,
and after `failureLimit` gave up — conflating "exited cleanly without reporting" with a
real crash. A prompt persona alone ("call kanban_complete") only *reduces* the probability;
a model going quiet is not a reliable "done" signal.

## Fix — two-sided (mechanism in rune, classification in Fleet)

We own rune, so the durable fix is mechanical: make going quiet impossible in headless mode,
and give Fleet an explicit signal when the model still won't comply.

**rune (`--require-tool`, opt-in):**
- New flag `--require-tool kanban_complete,kanban_block` (comma-separated terminal tools).
- When set, a `<headless-execution>` system-prompt block overrides the base prompt's
  interactive "ask one question / wait for approval" guidance.
- In the loop, when the model ends a turn with text and a required tool has **not** yet
  succeeded, append a persistence nudge and continue instead of `TurnDone`. Capped at
  `maxHeadlessNudges` (6) consecutive stops; the counter resets on any real tool progress,
  so genuine multi-step work is never interrupted.
- If the cap is exhausted, exit with **code 3** (`ErrIncompleteRequiredTool`) — distinct
  from generic error (1) and panic (2).
- rune stays kanban-agnostic; Fleet just names which tools are terminal.

**Fleet (classification + tuning):**
- `spawn-worker.ts` passes `--require-tool` per mode (work/decompose: `kanban_complete,kanban_block`; specify: `kanban_update`).
- `spawnRuneWorker` captures the child `exit` `{code,signal}`; `index.ts` records it in an
  in-memory `Map<runId,…>` — but **only if the run hadn't already reached a terminal state**
  via an MCP call (a normal `kanban_complete` moves the task off `running` before the process
  exits, so successes never enter the map and it stays tiny).
- `kanban-dispatcher.ts reclaim()` classifies: a reaped run that exited **3** → `blocked`
  with `result = "review-required: agent ended turn without completing"`, run outcome
  `incomplete`, and **not** counted as a crash. A definitive exit also short-circuits the
  heartbeat grace window (the process is provably gone). Everything else → the existing
  crash/expiry path.
- `failureLimit` 2 → 3; `claimGraceMs` 30s → 120s.

## Subtleties worth remembering

- **Why exit code, not "exit 0 = incomplete":** with `--require-tool`, a model that genuinely
  completes calls `kanban_complete` (task → done, never seen by reclaim) and exits 0; a model
  that won't finish exits 3. The explicit code beats inferring intent from silence.
- **No race recording exits:** the MCP `kanban_complete` HTTP call is handled synchronously in
  the main process *during* rune's tool call, so by the time the child's `exit` event fires the
  task is already `done`. The `status === 'running' && currentRunId === runId` guard in the
  exit handler is therefore reliable, not best-effort.
- **Restart safety:** the exit map is in-memory. After a Fleet restart an orphaned worker has
  no exit entry, so it falls back to the crash path — the safe default.
- **Don't reset the nudge counter on *completion*, reset it on *progress*:** the cap must only
  trip on a model that repeatedly stops without finishing, never on one doing long legit work.

## Files

- rune: `cmd/rune/{main,prompt}.go`, `internal/agent/{loop,agent,events,require_tool}.go`
- fleet: `src/main/kanban/{spawn-worker,kanban-dispatcher}.ts`, `src/main/index.ts`,
  `src/shared/{constants,kanban-types}.ts`

## See also

- `2026-05-31-kanban-orchestrator-work-mode-give-up.md` — the prior incident where a wrong
  (orchestrator) profile produced the same `gave-up: worker pid not alive` signature. That fix
  (`resolveWorkProfile`) and this one are complementary: one guarantees the worker *persona*
  tells the agent to complete; this one makes rune *enforce* it regardless of persona.
