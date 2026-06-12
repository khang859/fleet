# Kanban Deterministic Verify Gates

**Date:** 2026-06-12
**Status:** Approved design
**Issue:** #231 — Deterministic verify gates: per-project commands run before review/merge
**Builds on:** `2026-06-10-kanban-integration-autopilot-design.md` (the autopilot dispatcher, run modes, integrate/resolve)

## Problem

`kanban_complete` is accepted unconditionally. Nothing runs typecheck/test/lint
anywhere in the pipeline — the only quality gate is the human in the review
column (and nothing at all for scratch/dir tasks). A worker that breaks the
build still lands its branch in review and, for feature tasks, gets auto-merged
into the integration branch and pushed to a draft PR. This is the ceiling on
trusting the board to run autonomously: agent code review (#232) and full
autonomy build on top of a deterministic verify gate.

## Goal

A worker completion that breaks a project's verify commands (typecheck / tests /
lint) **never reaches the review column or auto-integrate**. The worker gets the
failure output and retries, bounded; after the cap the task is blocked and the
human is notified. Passing results are recorded as events so review/PR can show
`verified: typecheck ✓ tests ✓`.

## Non-goals

- No global on/off setting. The gate is **pure opt-in per project**: a project
  with no verify commands behaves exactly as today.
- The gate does not manage dependencies. Verify commands run in the task's
  worktree; making them runnable there (e.g. a leading `npm ci`) is the project
  owner's responsibility (see "Worktree dependencies").
- No verify on scratch/dir tasks — they have no branch to gate and nothing to
  merge.
- No concurrency cap on verify runs in v1 (see "Concurrency").

## Decisions (locked during brainstorming)

1. **Opt-in model:** pure per-project, no global kill-switch. Empty/absent
   `verify_commands` → no gate.
2. **Command shape:** ordered list of `{ label, command }`, **stop on first
   non-zero exit**. Per-command labels feed the `verify_passed` / `verify_failed`
   events.
3. **Execution model:** a verify run is a **deterministic (non-agent) run**
   (`RunMode 'verify'`). The task stays in `running` with the verify process as
   its tracked PID; the existing run-exit/reclaim lifecycle detects completion.
   **No new `TaskStatus`.**
4. **Fix run:** on failure, a fresh **`work`** run is spawned on the same
   worktree with the failure output injected into its prompt (not left in a
   comment the worker is never told to read).

## Architecture overview

```
kanban_complete (worktree task, scope.mode ∈ {work, resolve}, project has verify_commands):
  finalizeWorktree (commit)                      ← unchanged
  finishRun(scope.runId, 'completed', {summary}) ← KEEP: persists the summary + frees the run row
  appendEvent('verify_started')                  ← NOT 'completed' (a 'completed' event here would
                                                    fire a premature "Completed" notification for
                                                    work that may still bounce)
  startRun(mode='verify')  +  verifyRunner(...)  ← spawn a shell, capture output, get a {pid, logPath}
  setWorkerPid(task, verifyRunId, pid)           ← verify pid BECOMES tasks.worker_pid
  extendClaim(task, lock, ttl)                   ← refresh the lease for the verify duration
  hold the task in 'running'; return "Task committed; verifying."

dispatcher.reclaim() — new branch right AFTER the existing 'suggest' branch,
keyed on runMode(currentRunId) === 'verify' (reads the shell exit code as pass/fail):
  exit 0   → summary* = recoverWorkSummary(task)         ← recover BEFORE finishRun(verify)
             finishRun(verify,'completed'); reviewTask(summary*)
             setTaskConflict + event 'verify_passed' {labels}
  exit ≠0  → finishRun(verify,'failed', {error})
             if verify_attempts >= CAP → blockTask + event 'blocked' (→ notification)
             else → verify_attempts++; tail comment (+ log path); event 'verify_failed' {label};
                    spawn fresh 'work' fix run with failure tail in the prompt
  spawn-failed / exit==null (restart, expiry) → fail-OPEN:
             finishRun(verify,'spawn_failed'|'reclaimed'); reviewTask(summary*) + event 'verify_skipped' {reason}

* recoverWorkSummary = most recent run with mode==='work' && outcome==='completed' via
  listRuns(taskId) (newest-first). Recovered BEFORE finishRun(verify) so the verify run's own
  'completed' row never shadows the work run's summary.
```

The fix run is an ordinary `work` worker on the **same worktree**; it fixes,
calls `kanban_complete` again → re-verifies. `verify_attempts` bounds the loop.

## Data model changes

All additive, via the existing `addColumnIfMissing` migration pattern
(`kanban-store.ts` migration block). **Schema is at 13; this is migration 14.**

### `projects.verify_commands` (new TEXT, JSON, nullable)

```json
[{ "label": "typecheck", "command": "npm run typecheck" },
 { "label": "tests",     "command": "npm test" }]
```

- Validated with a zod schema on read/write (`z.array(z.object({ label: z.string().min(1), command: z.string().min(1) }))`). Absent/empty → no gate.
- Added to both `SCHEMA_SQL` (fresh installs) and the migration block (existing DBs).
- `Project` type (`kanban-types.ts`) gains `verifyCommands: VerifyCommand[]` (defaults `[]`).

### `tasks.verify_attempts` (new INTEGER NOT NULL DEFAULT 0)

Mirrors `tasks.resolve_attempts`. Cap = **2** (`VERIFY_ATTEMPT_CAP`), then blocked + notify.
`Task` type gains `verifyAttempts: number`; `rowToTask` reads it; `incrementVerifyAttempts(taskId)` store method mirrors `incrementResolveAttempts`.

### `RunMode` gains `'verify'`, `RunOutcome` gains `'failed'`

`RunMode` (`kanban-types.ts`): `'work' | 'decompose' | 'specify' | 'assign' | 'resolve' | 'suggest' | 'verify'`.
A `verify` run is deterministic — it spawns a shell, **not** an agent — and has
**no MCP tools** (it never talks to the MCP server).

`RunOutcome` gains `'failed'` (current union: `'completed' | 'blocked' | 'crashed' |
'timed_out' | 'spawn_failed' | 'gave_up' | 'reclaimed' | 'incomplete'`). A verify
run that exits non-zero is `finishRun(verifyRunId, 'failed', { error })` — distinct
from `'crashed'` (a process death) so run history reads honestly. Implementers must
handle the new member at any exhaustive `RunOutcome` switch (typecheck will flag them).

## Components

### 1. Project verify-commands config

- **Type:** `VerifyCommand { label: string; command: string }` in `kanban-types.ts`.
- **Store:** `verify_commands` column on `projects`; `rowToProject` parses the JSON
  (zod-validated, malformed → `[]`); `setProjectVerifyCommands(projectId, cmds)`.
- **Task → project mapping:** tasks carry `repoPath`, not `projectId`. Add
  `getProjectByPath(boardId, path)` to the store (the unique index
  `idx_projects_board_path` already exists). Normalize both sides
  (`path.resolve`) before matching, since raw `repo_path` on a task may not be a
  byte-for-byte match of the registered project path. No match, or match with
  empty commands → no gate.
- **MCP (add-time only):** extend `kanban_project_add` (the real tool name —
  `kanban-mcp-server.ts:417` → `commands.addProject`) to accept an optional
  `verify_commands` array (zod-parsed), applied when the project is created. Note
  `addProject` **throws on a duplicate path/name** (`kanban-commands.ts:1177-1182`),
  so re-adding is **not** an update channel — editing an existing project's
  commands goes through the UI/IPC path below, not MCP re-add.
- **UI (edit channel):** the Projects dialog (`ProjectsModal`) gains a
  verify-commands editor — a small label+command row list per project — wired
  through a new `setProjectVerifyCommands` store method via IPC + preload bridge,
  following the existing project-registry IPC pattern. This is the canonical way
  to change commands on an existing project.

### 2. The verify runner (deterministic spawn)

A new injectable on the **MCP server** (not the dispatcher — the trigger is the
`kanban_complete` handler). `KanbanMcpServer` gets a late-bound
`setVerifyRunner(fn)` setter, mirroring its existing late-bound `commands`
reference.

```ts
type VerifyRunner = (args: {
  runId: number;
  workspace: string;          // task.workspacePath — cwd for the commands
  commands: VerifyCommand[];
}) => number | undefined;     // returns pid, or undefined on spawn failure
```

**Log path (deterministic, not via runToken).** Worker logs are keyed by a random
`runToken` (`index.ts:961` → `logs/<runToken>.log`, `index.ts:1008`) and that token
lives only inside the spawnWorker closure — reclaim **cannot** reconstruct it. The
verify log instead uses a runId-deterministic path so reclaim can read the tail
without any stored state: a single helper `verifyLogPath(runId) =
join(KANBAN_HOME, 'logs', `verify-${runId}.log`)`. The verify runner writes there;
the **dispatcher** reads it via a new injected dep `verifyLogPath: (runId: number)
=> string` on `DispatcherDeps` (the dispatcher has no `KANBAN_HOME`; the `index.ts`
closure supplies it). Both sides call the same helper.

- Spawns **one** detached shell that runs the labeled commands **in order**,
  stop on first non-zero exit; the process exit code is that first failure's
  code (or 0 if all pass). Writes to `verifyLogPath(runId)`. Reuse the
  file-capture pattern from `spawnRuneWorker` (`openSync(logPath,'a')` +
  `stdio:['ignore', out, out]` + `closeSync`).
- Output is written so that a label boundary is greppable (echo a
  `=== verify: <label> ===` line before each command) — lets the failure tail
  identify which command failed.
- **Wiring in `index.ts`:** define the runner AFTER `workerExits` (it must close
  over the same map the dispatcher reads). Its `onExit` writes a **raw** entry —
  `workerExits.set(runId, { code, signal })` with **no** `detectAuthFailure` /
  `extractRuneError` / `startupCrash` classification (those are rune-specific and
  would misread a test exit-3 or a "401" string in test output as a fatal block).
  Keep the same `t.status==='running' && t.currentRunId===runId` guard the rune
  recorder uses (`index.ts:1044`) so a verify process that exits *after* reclaim
  already fail-opened (e.g. claim expiry mid-verify) doesn't leave a stale
  `workerExits` entry. Call `kanbanMcp.setVerifyRunner(...)` after both
  `workerExits` and the MCP server exist.

### 3. `kanban_complete` handler change (`kanban-mcp-server.ts`)

In the existing worktree branch (currently `finalizeWorktree` → `reviewTask` →
`setTaskConflict` → `finishRun` → events → comment → `unregisterRun`):

- **Gate condition:** `task.workspaceKind === 'worktree'` **and**
  `scope.mode ∈ {work, resolve}` **and** `getProjectByPath(boardId, repoPath)` has
  non-empty `verify_commands`. (Exclude `decompose`/`specify`/`assign`/`suggest`
  — they don't produce reviewable worktree diffs to gate.)
- **When gated:**
  1. `finalizeWorktree` (commit) — unchanged.
  2. `finishRun(scope.runId, 'completed', { summary, metadata })` — **kept**, so
     the summary persists in `task_runs` and the work run row leaves `running`
     (the `replyAndResume`/`finishRun` `WHERE status='running'` guard depends on
     this). **Do not** append the `completed` event on the gated path — that event
     fires a premature "Completed" notification (`kanban-notifications.ts`) for work
     that may still bounce. Append `appendEvent('verify_started')` instead; the
     later `verify_passed` event is the real success signal. (The non-gated path
     keeps its `completed` event unchanged.)
  3. `startRun(task.id, null, null, 'verify')` → `verifyRunId` (signature is
     `startRun(taskId, profile, workerPid, mode)`; a verify run has no profile/pid yet).
  4. `verifyRunner({ runId: verifyRunId, workspace, commands })` → pid.
     - pid present → `setWorkerPid(task.id, verifyRunId, pid)` (verify pid becomes
       `worker_pid`, keeping reclaim's `dead` check false while verify lives) +
       `extendClaim`.
     - pid undefined (spawn failed) → **fail-open immediately**:
       `finishRun(verifyRunId, 'spawn_failed')` (close the orphaned verify run) +
       `reviewTask` + `setTaskConflict` + `appendEvent('verify_skipped', { reason })`,
       exactly the old non-gated path. Never trap a task because verify infra is broken.
  5. `unregisterRun(token)`; return `"Task ${id} committed; verifying."`
- **When not gated:** the existing path is unchanged.

The `review-required: N files…` comment currently added at complete time stays
at complete time but is reworded for the gated path to `verifying: N files on
<branch>` (the `reviewStat` is computed once and reused).

### 4. `reclaim()` verify branch (`kanban-dispatcher.ts`)

A new branch placed **immediately after the `suggest` branch** (so it pre-empts
the agent-oriented exit-3 / `blockNow` interpretation below it — test runners
routinely exit 3, which the existing code would misread as REVIEW_REQUIRED):

```
reclaimMode === 'verify':
  exit = workerExit(currentRunId)            // { code, signal } | undefined
  if exit == null (dead pid / expired / app restart with empty map):
     → finishRun(verify,'reclaimed'); reviewFromVerify(task, 'verify outcome unknown')   // fail-open
  else if exit.code === 0:
     → reviewFromVerify(task, null)          // recovers summary, THEN finishRun(verify) inside
  else (exit.code !== 0):
     → // mirror spawnResolve's pre-increment cap check (kanban-dispatcher.ts:513-520)
       finishRun(verify,'failed', { error: `verify failed: <label> (exit ${code})` })
       if task.verifyAttempts >= VERIFY_ATTEMPT_CAP:
          blockTask(`verify failed after ${CAP} attempt(s): <label>`); appendEvent('blocked')
       else:
          incrementVerifyAttempts(task)
          tail = readLogTail(verifyLogPath(currentRunId), 8KB)   // readLogTail must be exported
          addComment(task, 'verify', `verify failed: <label> ✗\n${tail}\n(full log: ${verifyLogPath(currentRunId)})`)
          appendEvent('verify_failed', { label })
          spawnVerifyFix(task, tail)          // see §5
  clearWorkerExit(currentRunId) on every path
```

`reviewFromVerify(task, skipReason)` is the shared helper for both pass-like paths
(clean pass and fail-open). It **recovers the work summary first**
(`recoverWorkSummary`: newest run with `mode==='work' && outcome==='completed'` via
`listRuns`), **then** `finishRun(verifyRunId, 'completed')`, `reviewTask(summary)`,
`setTaskConflict` (via the already-imported `checkMergeConflicts`,
`kanban-dispatcher.ts:8`), and appends `verify_passed { labels }` (clean pass) or
`verify_skipped { reason: skipReason }` (fail-open). Recovering before
`finishRun(verify)` is mandatory — otherwise the verify run's own `completed` row,
being newest, shadows the work summary with `null`.

`verifyLogPath(runId)` is the injected `DispatcherDeps` member from §2 — a
runId-deterministic path, **not** the random-`runToken` worker-log scheme.

**Cap semantics** (`VERIFY_ATTEMPT_CAP = 2`, mirroring `RESOLVE_ATTEMPT_CAP`):
check the pre-increment value, exactly like `spawnResolve`. Failure 1 (attempts
0 < 2) → increment→1 + fix run; failure 2 (1 < 2) → increment→2 + fix run; failure
3 (2 ≥ 2) → block. Two fix runs, block on the third failure.

### 5. `spawnVerifyFix(task, failureTail)` (`kanban-dispatcher.ts`)

Mirrors `spawnResolve`, but spawns a `work` run on the existing worktree:

- The task is already `running` (verify just exited) and the dispatcher tick is
  single-threaded, so no claim race — `startRun(task.id, profile, null, 'work')`
  (signature `startRun(taskId, profile, workerPid, mode)`; `profile` is the resolved
  work profile, pid set via `setWorkerPid` after spawn), refresh the claim lease,
  `appendEvent('spawned', { mode:'work', reason:'verify-fix', attempt })`.
- `this.deps.spawnWorker({ task, runId, lock, workspace, mode: 'work', verifyFailure: failureTail })`.
- On spawn failure: `recordFailure` + `setStatusCleared(task,'ready')` so a later
  tick retries (matches `spawnResolve`'s fallback).

### 6. Fix-run prompt (`spawn-worker.ts`, `index.ts`)

- `SpawnWorkerArgs` and `BuildWorkerInput` gain an optional `verifyFailure?: string`
  (precedent: `resolveTarget`). The `index.ts` `spawnWorker` closure passes it
  through to `spawnRuneWorker`.
- `buildPrompt` (mode `work`): when `verifyFailure` is set, prepend a block:

  > Your previous completion failed the project's verify commands. Fix the cause
  > and call `kanban_complete` again — it will re-run verification.
  >
  > ```
  > <verifyFailure tail>
  > ```

  This is the channel that actually delivers the failure to the fix worker;
  comments are **not** in the worker prompt.

### 7. Output storage

- The full combined output stays in the on-disk verify log at
  `verifyLogPath(runId)`. **No `task_artifact`** — `addArtifact`/`prepareArtifactFile`
  reject paths outside the task workspace (`artifact-files.ts`), and copying the log
  into the worktree would pollute the branch (the fix run's next `finalizeWorktree`
  would commit it). The artifact machinery is also PM-only (`kanban_artifact_read`),
  so it wouldn't reach the fix worker anyway.
- Only a `readLogTail(...8KB)` tail goes into the failure comment, with the on-disk
  log path appended for a human who wants the full output. (A 16KB+ comment would be
  re-injected into *every* future `kanban_show` for the task's life — the fix worker,
  PM views, post-fix review.) The fix worker receives the same tail through its
  prompt (§6), which is the channel that actually drives the fix.

### 8. `orchestratorRunningCount` fix (`kanban-store.ts`)

The count currently excludes only `mode = 'work'` (`WHERE ... mode != 'work'`).
A `verify` run is not an orchestrator run; left unfixed it would consume a
`maxDecompose` slot and throttle decompose/assign/suggest. Change to
`mode NOT IN ('work','verify')`.

### 9. Events & notifications

- `verify_started`, `verify_passed { labels }`, `verify_failed { label }`,
  `verify_skipped { reason }` — appended via `appendEvent`, surfaced on the task
  card / detail through the existing event stream. No new board column.
- The cap-reached `blocked` event drives the existing notifier
  (`kanban-notifications.ts`) — no new notification wiring.
- **v1 scope:** verify results are surfaced as board events only. Issue #231's
  "review/PR shows verified: typecheck ✓" is satisfied at the board/event level;
  pushing a verified-status check onto the GitHub PR is **out of scope for v1**
  (a fast follow once #232 agent review lands).

## Worktree dependencies

`prepareWorkspace` does a bare `git worktree add` — a fresh worktree has no
`node_modules`. Today agents install deps mid-run incidentally, so by verify time
the worktree *often* has them, but that is not guaranteed. The supported answer:
a project's `verify_commands` may lead with an install step (e.g.
`{ label: 'install', command: 'npm ci' }`). Document this in the Projects dialog
helper text. Note the lease budget: `npm ci` on an Electron repo is slow but
cached; `extendClaim` at verify start gives the 15-minute default lease, which is
sufficient. A worktree-creation setup hook is a better long-term fix and is out
of scope here.

## Edge cases

- **No project / no commands:** not gated — old path verbatim.
- **Spawn failure or unknown exit (app restart mid-verify):** fail-open to review
  with `verify_skipped`. The "never reaches review" guarantee is about *broken
  code* (a clean non-zero exit), not infra failures; trapping legitimate work on a
  verify-infra hiccup is the worse failure. This tension is intentional and called
  out.
- **`resolve` completions are gated too** — re-verifying after a conflict
  resolution is desirable. `decompose`/`specify`/`assign`/`suggest` are excluded.
- **Cap reached:** `blocked` + notification; the human takes over. `verify_attempts`
  is **not** reset on block (a later manual re-open starts fresh only if explicitly
  cleared — out of scope).
- **Claim expiry mid-verify:** `extendClaim` at verify start mitigates; if it still
  expires, the `exit==null` fail-open path applies.

## Testing

Dispatcher tests inject a fake `workerExit` + fake `spawnWorker`/verify wiring:

1. **Pass:** verify run exits 0 → task lands in `review`, `verify_passed` event,
   conflict state set, summary preserved on the review card.
2. **Fail under cap:** exit ≠0 → `verify_attempts` incremented, tail comment added
   (with log path), a `work` fix run spawned with `verifyFailure` in its input,
   `verify_failed` event.
3. **Fail at cap:** exit ≠0 with `verify_attempts` at cap → `blocked` + notify, no
   new run.
4. **Spawn fail-open:** verify runner returns undefined → task in `review`,
   `verify_skipped`.
5. **Unknown exit:** `exit==null` + dead pid → fail-open to `review`,
   `verify_skipped`.
6. **Opt-out:** project with no commands → `kanban_complete` lands in `review`
   directly, no verify run created.
7. **Exit-code-3 isolation:** a `verify` run exiting 3 routes through the verify
   branch (fail), **not** the REVIEW_REQUIRED branch.
8. **Orchestrator slots:** a running `verify` run does not decrement the decompose
   budget (`orchestratorRunningCount` excludes it).

Store tests: the two new columns + migration 14 idempotency; `getProjectByPath`
normalization; `verify_commands` JSON round-trip + malformed → `[]`.
MCP test: `kanban_project_add` with `verify_commands`; gated `kanban_complete`
starts a verify run instead of moving to review.

## Files touched

- `src/shared/kanban-types.ts` — `VerifyCommand`, `Project.verifyCommands`,
  `Task.verifyAttempts`, `RunMode += 'verify'`, `RunOutcome += 'failed'`.
- `src/main/kanban/schema.ts` — `SCHEMA_VERSION = 14`; `verify_commands` in
  `projects`, `verify_attempts` in `tasks` (SCHEMA_SQL).
- `src/main/kanban/kanban-store.ts` — migration 14; `rowToProject`/`rowToTask`
  reads; `setProjectVerifyCommands`, `getProjectByPath`, `incrementVerifyAttempts`;
  `orchestratorRunningCount` fix (`mode NOT IN ('work','verify')`).
- `src/main/kanban/kanban-mcp-server.ts` — `setVerifyRunner`; gated
  `kanban_complete` branch; `kanban_project_add` (the real tool, not
  `_register`) gains optional `verify_commands`.
- `src/main/kanban/kanban-commands.ts` — `addProject` accepts `verify_commands`;
  `setProjectVerifyCommands` passthrough for the edit channel.
- `src/main/kanban/kanban-dispatcher.ts` — `reclaim()` verify branch;
  `reviewFromVerify`/`recoverWorkSummary`; `spawnVerifyFix`; `VERIFY_ATTEMPT_CAP`;
  `verifyLogPath` dep added to `DispatcherDeps`.
- `src/main/kanban/spawn-worker.ts` — a `spawnVerify` shell-runner helper; export
  `readLogTail` (currently module-private); `verifyFailure` in
  `BuildWorkerInput`/`buildPrompt`; `requireToolsForMode('verify')` → none.
- `src/main/index.ts` — define the verify runner over `workerExits` (raw recorder,
  same running/currentRunId guard) + `verifyLogPath(runId)` helper closing over
  `KANBAN_HOME`, wire both into the MCP server (`setVerifyRunner`) and the
  dispatcher (`verifyLogPath` dep); pass `verifyFailure` through the `spawnWorker`
  closure.
- `src/main/kanban/kanban-ipc.ts`, `src/preload/index.ts`,
  `src/shared/ipc-channels.ts`, `src/renderer/src/store/kanban-store.ts`,
  `src/renderer/src/components/kanban/ProjectsModal.tsx` — read/update
  verify_commands from the Projects dialog.

## Implementation phasing

1. Data model + store (columns, migration 14, types, `getProjectByPath`,
   `orchestratorRunningCount` fix) — pure, fully unit-testable.
2. `spawnVerify` shell runner + `index.ts` raw-exit wiring + `setVerifyRunner`.
3. `kanban_complete` gated branch.
4. `reclaim()` verify branch + `spawnVerifyFix` + `verifyFailure` prompt.
5. MCP `kanban_project_add` verify_commands + Projects dialog UI (edit channel).
6. Full dispatcher/store/MCP test pass.
