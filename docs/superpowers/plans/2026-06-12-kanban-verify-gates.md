# Deterministic Verify Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a worktree task's worker calls `kanban_complete`, run per-project verify commands (typecheck/test/lint) in the worktree before the task reaches review/integrate; on failure bounce a fresh work run with the output, bounded retries then blocked + notify.

**Architecture:** A verify run is a deterministic (non-agent) run (`RunMode 'verify'`) spawned from the MCP `kanban_complete` handler. The task stays `running` with the verify shell as its tracked PID; `reclaim()` reads the shell exit code (0=pass, ≠0=fail) through the existing `workerExit` channel and routes pass→review / fail→fix-run / cap→blocked. Pure opt-in per project (no commands ⇒ no gate).

**Tech Stack:** TypeScript, better-sqlite3, Electron main/preload/renderer IPC, vitest. Spec: `docs/superpowers/specs/2026-06-12-kanban-verify-gates-design.md`.

**Conventions (non-negotiable):**
- No `as` casts and no `eslint-disable` in `src` production code. Use zod for runtime validation. The only sanctioned cast is the file-local raw-sqlite-row `Record<string, unknown>` query convention already in `kanban-store.ts`. Tests may cast.
- Verify each task with `npm run typecheck` (vitest does NOT typecheck) and the relevant `npx vitest run <file>`.
- Commit messages end with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/shared/kanban-types.ts` | Shared types | `VerifyCommand`, `Project.verifyCommands`, `Task.verifyAttempts`, `RunMode += 'verify'`, `RunOutcome += 'failed'` |
| `src/main/kanban/schema.ts` | DDL | `SCHEMA_VERSION = 14`; `verify_commands` col on `projects`, `verify_attempts` on `tasks` |
| `src/main/kanban/kanban-store.ts` | Persistence | migration 14; row reads; `setProjectVerifyCommands`, `getProjectByPath`, `incrementVerifyAttempts`, `claimForVerifyFix`; `orchestratorRunningCount` fix |
| `src/main/kanban/spawn-worker.ts` | Worker/verify spawn + prompts | export `readLogTail`; `spawnVerify` helper; `verifyFailure` in `BuildWorkerInput`/`buildPrompt` |
| `src/main/kanban/kanban-dispatcher.ts` | Tick orchestration | `DispatcherDeps.verifyLogPath`, `SpawnWorkerArgs.verifyFailure`, `VERIFY_ATTEMPT_CAP`, `reclaim()` verify branch, `reviewFromVerify`, `spawnVerifyFix` |
| `src/main/kanban/kanban-mcp-server.ts` | MCP tools | `VerifyRunner` type + `setVerifyRunner`; gated `kanban_complete`; `kanban_project_add` verify_commands |
| `src/main/kanban/kanban-commands.ts` | Command layer | `addProject` verify_commands; `setProjectVerifyCommands` |
| `src/main/index.ts` | Wiring | `verifyLogPath(runId)` helper; `setVerifyRunner` (raw recorder); `verifyFailure` passthrough; dispatcher dep |
| `src/shared/ipc-channels.ts`, `src/shared/ipc-api.ts`, `src/main/kanban/kanban-ipc.ts`, `src/preload/index.ts`, `src/renderer/src/components/kanban/ProjectsModal.tsx` | Projects dialog edit channel | new `KANBAN_SET_PROJECT_VERIFY` channel + editor |

Tasks 1→7 are the backend (each green on its own); Task 8 is the UI edit channel.

---

## Task 1: Shared types

**Files:**
- Modify: `src/shared/kanban-types.ts`

- [ ] **Step 1: Add `RunMode 'verify'` and `RunOutcome 'failed'`**

In `src/shared/kanban-types.ts`, change the `RunMode` line (currently ends `... | 'resolve' | 'suggest'`):

```ts
/** What a run is doing. 'work' = normal worker; orchestrator runs are 'decompose' | 'specify' | 'assign' | 'resolve' | 'suggest'; 'verify' is a deterministic (non-agent) verify-command run. */
export type RunMode =
  | 'work'
  | 'decompose'
  | 'specify'
  | 'assign'
  | 'resolve'
  | 'suggest'
  | 'verify';
```

Add `'failed'` to `RunOutcome` (after `'incomplete'`):

```ts
export type RunOutcome =
  | 'completed'
  | 'blocked'
  | 'crashed'
  | 'timed_out'
  | 'spawn_failed'
  | 'gave_up'
  | 'reclaimed'
  | 'incomplete' // exited cleanly without calling a completion tool (review-required)
  | 'failed'; // a verify run exited non-zero (deterministic verify-command failure)
```

- [ ] **Step 2: Add `VerifyCommand` + `Project.verifyCommands`**

Add the type just above `export interface Project {`:

```ts
/** One labeled verify command run in a task's worktree before it reaches review (spec §231). */
export interface VerifyCommand {
  label: string;
  command: string;
}
```

Add to the `Project` interface body (after `description: string | null;`):

```ts
  /** Ordered verify commands run after a worktree completion; empty = no verify gate. */
  verifyCommands: VerifyCommand[];
```

- [ ] **Step 3: Add `Task.verifyAttempts`**

In the `Task` interface, after `resolveAttempts: number;`:

```ts
  /** Bounded verify-fix budget; mirrors resolveAttempts. */
  verifyAttempts: number;
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: FAILS in `kanban-store.ts` (rowToProject/rowToTask don't yet populate the new fields). That is expected — Task 2 fixes it. Do NOT fix it here.

- [ ] **Step 5: Commit**

```bash
git add src/shared/kanban-types.ts
git commit -m "feat(kanban): verify-gate types (RunMode 'verify', RunOutcome 'failed', VerifyCommand)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Schema, migration, and store methods

**Files:**
- Modify: `src/main/kanban/schema.ts`
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-verify-store.test.ts` (create)

- [ ] **Step 1: Write the failing store test**

Create `src/main/__tests__/kanban-verify-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';

const TEST_DIR = join(tmpdir(), `fleet-verify-store-${Date.now()}`);

function makeStore(): KanbanStore {
  let t = 1000;
  return new KanbanStore(join(TEST_DIR, `s-${Math.random()}.db`), { now: () => (t += 1) });
}

describe('verify-gate store', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('round-trips verify_commands on a project and finds it by path', () => {
    const store = makeStore();
    const dir = mkdtempSync(join(TEST_DIR, 'repo-'));
    const p = store.addProject({ boardId: 'default', name: 'app', path: dir });
    expect(p.verifyCommands).toEqual([]);
    store.setProjectVerifyCommands(p.id, [
      { label: 'typecheck', command: 'npm run typecheck' },
      { label: 'tests', command: 'npm test' }
    ]);
    const byPath = store.getProjectByPath('default', dir);
    expect(byPath?.verifyCommands).toEqual([
      { label: 'typecheck', command: 'npm run typecheck' },
      { label: 'tests', command: 'npm test' }
    ]);
    store.close();
  });

  it('getProjectByPath normalizes trailing-slash differences', () => {
    const store = makeStore();
    const dir = mkdtempSync(join(TEST_DIR, 'repo-'));
    const p = store.addProject({ boardId: 'default', name: 'app', path: dir });
    expect(store.getProjectByPath('default', dir + '/')?.id).toBe(p.id);
    store.close();
  });

  it('malformed verify_commands JSON reads back as []', () => {
    const store = makeStore();
    const dir = mkdtempSync(join(TEST_DIR, 'repo-'));
    const p = store.addProject({ boardId: 'default', name: 'app', path: dir });
    // simulate corruption via the raw handle
    store.rawDbForTest().prepare('UPDATE projects SET verify_commands=? WHERE id=?').run('not json', p.id);
    expect(store.getProject(p.id)?.verifyCommands).toEqual([]);
    store.close();
  });

  it('incrementVerifyAttempts bumps the counter', () => {
    const store = makeStore();
    const t = store.createTask({ title: 'x', status: 'running' });
    expect(store.getTask(t.id)?.verifyAttempts).toBe(0);
    store.incrementVerifyAttempts(t.id);
    expect(store.getTask(t.id)?.verifyAttempts).toBe(1);
    store.close();
  });

  it('orchestratorRunningCount excludes verify runs', () => {
    const store = makeStore();
    const t = store.createTask({ title: 'x', status: 'running' });
    store.startRun(t.id, null, 111, 'verify');
    expect(store.orchestratorRunningCount()).toBe(0);
    store.close();
  });

  it('claimForVerifyFix re-claims a running task with a fresh lock', () => {
    const store = makeStore();
    const t = store.createTask({ title: 'x', status: 'running' });
    expect(store.claimForVerifyFix(t.id, 'NL', 1000)).toBe(true);
    expect(store.getTask(t.id)?.claimLock).toBe('NL');
    store.close();
  });
});
```

> The test uses `store.rawDbForTest()`. If the store has no such accessor, add a minimal one guarded for tests: `rawDbForTest() { return this.db; }` near the top of the class (it returns the better-sqlite3 handle). This keeps the corruption test from needing a cast on a private field.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-verify-store.test.ts`
Expected: FAIL (methods/columns missing).

- [ ] **Step 3: Add columns to `SCHEMA_SQL`**

In `src/main/kanban/schema.ts`:

Bump the version line:
```ts
export const SCHEMA_VERSION = 14;
```

In the `tasks` table, after `resolve_attempts INTEGER NOT NULL DEFAULT 0,`:
```ts
  verify_attempts INTEGER NOT NULL DEFAULT 0,
```

In the `projects` table (after `description TEXT,`):
```ts
  verify_commands TEXT,
```

- [ ] **Step 4: Add migration 14**

In `src/main/kanban/kanban-store.ts`, in `migrate()`, immediately after the `if (current < 13) { ... }` block and before the "Seed the permanent default board" comment:

```ts
    if (current < 14) {
      // Deterministic verify gates (#231): per-project verify commands +
      // a bounded verify-fix budget on tasks. Additive, idempotent.
      this.addColumnIfMissing('projects', 'verify_commands', 'TEXT');
      this.addColumnIfMissing('tasks', 'verify_attempts', 'INTEGER NOT NULL DEFAULT 0');
    }
```

- [ ] **Step 5: Populate the new fields in row readers**

In `rowToProject` (after `description: ... ?? null,`):
```ts
      verifyCommands: parseVerifyCommands(r.verify_commands),
```

In `rowToTask` (after `resolveAttempts: Number(r.resolve_attempts ?? 0),`):
```ts
      verifyAttempts: Number(r.verify_attempts ?? 0),
```

Add a module-level zod-validated parser near the top of `kanban-store.ts` (after the imports; import `z` from `'zod'` if not already imported, and `VerifyCommand` from the shared types):

```ts
const VERIFY_COMMANDS_SCHEMA = z.array(
  z.object({ label: z.string().min(1), command: z.string().min(1) })
);

/** Parse a project's verify_commands JSON; malformed/empty → []. */
function parseVerifyCommands(raw: unknown): VerifyCommand[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    return VERIFY_COMMANDS_SCHEMA.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}
```

- [ ] **Step 6: Add the store methods**

Add near `getProjectByName` / `addProject`:

```ts
  /** Find a registered project by its on-disk path (normalized), for the verify gate. */
  getProjectByPath(boardId: string, path: string): Project | null {
    const target = resolve(path);
    for (const p of this.listProjects(boardId)) {
      if (resolve(p.path) === target) return p;
    }
    return null;
  }

  setProjectVerifyCommands(projectId: string, commands: VerifyCommand[]): void {
    const json = JSON.stringify(VERIFY_COMMANDS_SCHEMA.parse(commands));
    this.db
      .prepare('UPDATE projects SET verify_commands=?, updated_at=? WHERE id=?')
      .run(json, this.now(), projectId);
  }
```

Import `resolve` from `'path'` at the top if not present.

Add near `incrementResolveAttempts`:

```ts
  incrementVerifyAttempts(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET verify_attempts = verify_attempts + 1, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }
```

Add near `claimForResolve` (CAS a `running` task to a fresh lock for the verify-fix run):

```ts
  /** Re-claim a running task (whose verify run just ended) with a fresh lock for a verify-fix run. */
  claimForVerifyFix(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET claim_lock=@lock, claim_expires=@expires, last_heartbeat_at=@ts, updated_at=@ts
         WHERE id=@id AND status='running'`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }
```

- [ ] **Step 7: Fix `orchestratorRunningCount`**

Change the SQL in `orchestratorRunningCount`:
```ts
         WHERE t.status='running' AND r.mode NOT IN ('work','verify')
```

- [ ] **Step 8: Add the test accessor if missing**

If `rawDbForTest` doesn't exist, add it in the class body:
```ts
  /** Test-only raw handle for simulating corruption; do not use in production code. */
  rawDbForTest(): import('better-sqlite3').Database {
    return this.db;
  }
```

- [ ] **Step 9: Run the test + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-verify-store.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS (Task 1's rowToProject/rowToTask error is now resolved).

- [ ] **Step 10: Commit**

```bash
git add src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-verify-store.test.ts
git commit -m "feat(kanban): verify-gate schema (migration 14) + store methods

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `spawnVerify` helper + `verifyFailure` prompt

**Files:**
- Modify: `src/main/kanban/spawn-worker.ts`
- Test: `src/main/__tests__/kanban-verify-spawn.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/kanban-verify-spawn.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnVerify, buildVerifyScript } from '../kanban/spawn-worker';

const TEST_DIR = join(tmpdir(), `fleet-verify-spawn-${Date.now()}`);

describe('buildVerifyScript', () => {
  it('chains commands with markers and stop-on-first-failure semantics', () => {
    const script = buildVerifyScript([
      { label: 'typecheck', command: 'echo tc' },
      { label: 'tests', command: 'echo te' }
    ]);
    expect(script).toContain('=== verify: typecheck ===');
    expect(script).toContain('=== verify: tests ===');
    expect(script).toContain('&&'); // failure short-circuits the chain
  });
});

describe('spawnVerify', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('runs commands, writes the log, and exits 0 on success', async () => {
    const logPath = join(TEST_DIR, 'ok.log');
    const code = await new Promise<number | null>((res) => {
      spawnVerify(
        { workspace: TEST_DIR, commands: [{ label: 'one', command: 'true' }], logPath },
        (exit) => res(exit.code)
      );
    });
    expect(code).toBe(0);
    expect(readFileSync(logPath, 'utf-8')).toContain('=== verify: one ===');
  });

  it('stops at the first failing command and exits non-zero', async () => {
    const logPath = join(TEST_DIR, 'fail.log');
    const code = await new Promise<number | null>((res) => {
      spawnVerify(
        {
          workspace: TEST_DIR,
          commands: [
            { label: 'first', command: 'false' },
            { label: 'second', command: 'echo SHOULD_NOT_RUN' }
          ],
          logPath
        },
        (exit) => res(exit.code)
      );
    });
    expect(code).not.toBe(0);
    expect(readFileSync(logPath, 'utf-8')).not.toContain('SHOULD_NOT_RUN');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-verify-spawn.test.ts`
Expected: FAIL (`spawnVerify`/`buildVerifyScript` not exported).

- [ ] **Step 3: Export `readLogTail` and implement `spawnVerify` + `buildVerifyScript`**

In `src/main/kanban/spawn-worker.ts`:

Change `function readLogTail(` to `export function readLogTail(`.

Add `import type { VerifyCommand } from '../../shared/kanban-types';` to the type imports (or extend the existing import).

Add, near `spawnRuneWorker`:

```ts
/**
 * Builds a single POSIX-sh script that runs each verify command in order, printing a
 * `=== verify: <label> ===` marker before each. `&&` chaining gives stop-on-first-failure
 * with the failing command's exit code propagated (echo always returns 0). The last marker
 * in the log identifies which command failed.
 */
export function buildVerifyScript(commands: VerifyCommand[]): string {
  return commands
    .map((c) => {
      const marker = `=== verify: ${c.label} ===`;
      // single-quote the marker for echo; escape any single quotes in the label
      const safeMarker = marker.replace(/'/g, `'\\''`);
      return `echo '${safeMarker}' && ${c.command}`;
    })
    .join(' && ');
}

/**
 * Spawns the verify commands as one detached `sh -c` shell in the task's worktree,
 * combined stdout+stderr → logPath (reusing spawnRuneWorker's fd-safe capture). Returns
 * the pid (or undefined on spawn failure). Deterministic: no agent, no MCP.
 */
export function spawnVerify(
  input: { workspace: string; commands: VerifyCommand[]; logPath: string },
  onExit?: (exit: WorkerExit) => void
): number | undefined {
  mkdirSync(dirname(input.logPath), { recursive: true });
  const out = openSync(input.logPath, 'a');
  const child = spawn('sh', ['-c', buildVerifyScript(input.commands)], {
    cwd: input.workspace,
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    log.error('verify run failed to spawn', { error: err.message });
  });
  child.on('exit', (code, signal) => onExit?.({ code, signal }));
  closeSync(out);
  child.unref();
  return child.pid;
}
```

(`mkdirSync`, `dirname`, `openSync`, `closeSync`, `spawn` are already imported in this file — confirm and reuse; do not re-import.)

- [ ] **Step 4: Add `verifyFailure` to `BuildWorkerInput` and the work prompt**

In `BuildWorkerInput`, after `resolveTarget?: string;`:
```ts
  /** Failure output from a prior verify run; injected into the work prompt so the fix worker sees it. */
  verifyFailure?: string;
```

In `buildPrompt`, replace the final `work` return (`return ( `work kanban task ...` ...)`) with a version that prepends the verify-failure block when present:

```ts
  const verifyBlock = input.verifyFailure
    ? `Your previous completion failed the project's verify commands. Fix the cause and call ` +
      `kanban_complete again — it will re-run verification.\n\n\`\`\`\n${input.verifyFailure}\n\`\`\`\n\n`
    : '';
  return (
    verifyBlock +
    `work kanban task ${task.id}: ${task.title}\n\n${task.body}` +
    attachmentsSection(input) +
    docsSection(input) +
    `\n\nIf you produce any durable output files (docs, research, data), register each with the ` +
    `kanban_artifact tool (path relative to your working directory) so the user can find them.`
  );
```

Note: `requireToolsForMode('verify')` needs no case — the `default: return null` already covers it (a verify run has no terminal MCP tool). Leave `requireToolsForMode` unchanged.

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-verify-spawn.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/spawn-worker.ts src/main/__tests__/kanban-verify-spawn.test.ts
git commit -m "feat(kanban): spawnVerify shell runner + verifyFailure work prompt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Dispatcher `reclaim()` verify branch

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts`
- Test: `src/main/__tests__/kanban-dispatcher-verify.test.ts` (create)

This is the core. The branch goes **immediately after** the `suggest` branch (after the `continue;` that closes it, ~line 168) and **before** the `if (exit?.code === REVIEW_REQUIRED_EXIT_CODE)` branch (~line 175).

- [ ] **Step 1: Write the failing tests**

Create `src/main/__tests__/kanban-dispatcher-verify.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanDispatcher, type SpawnWorkerArgs, type WorkerExit } from '../kanban/kanban-dispatcher';

const TEST_DIR = join(tmpdir(), `fleet-disp-verify-${Date.now()}`);

function baseConfig() {
  return {
    failureLimit: 3,
    claimGraceMs: 0,
    maxInProgress: 3,
    claimTtlMs: 100000,
    autoDecompose: false,
    autoAssign: false,
    autoIntegrate: false,
    maxDecompose: 1,
    artifactRetentionDays: 0
  };
}

// A worktree task parked in 'running' with a live verify run, as kanban_complete leaves it.
function makeVerifyingTask(store: KanbanStore) {
  const t = store.createTask({
    title: 'x',
    status: 'running',
    workspaceKind: 'worktree',
    workspacePath: join(TEST_DIR, 'wt')
  });
  store.claimTask(t.id, 'L', 100000);
  const work = store.startRun(t.id, 'w', 100, 'work');
  store.finishRun(work.id, 'completed', { summary: 'did the work' });
  const verify = store.startRun(t.id, null, 200, 'verify');
  store.setWorkerPid(t.id, verify.id, 200);
  return { task: store.getTask(t.id)!, verifyRunId: verify.id };
}

describe('reclaim() verify branch', () => {
  beforeEach(() => mkdirSync(join(TEST_DIR, 'wt'), { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('exit 0 → task goes to review with the recovered work summary + verify_passed event', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `a-${Math.random()}.db`), { now: () => clock.t });
    const { task, verifyRunId } = makeVerifyingTask(store);
    const exits = new Map<number, WorkerExit>([[verifyRunId, { code: 0, signal: null }]]);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: (id) => exits.delete(id),
      verifyLogPath: () => join(TEST_DIR, 'v.log')
    });
    disp.reclaim();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(after.result).toBe('did the work');
    expect(store.listEvents(task.id).some((e) => e.kind === 'verify_passed')).toBe(true);
    store.close();
  });

  it('exit ≠0 under cap → spawns a work fix run with verifyFailure + verify_failed event', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `b-${Math.random()}.db`), { now: () => clock.t });
    const { task, verifyRunId } = makeVerifyingTask(store);
    const logPath = join(TEST_DIR, 'v.log');
    writeFileSync(logPath, '=== verify: tests ===\nFAIL some.test\n');
    const exits = new Map<number, WorkerExit>([[verifyRunId, { code: 1, signal: null }]]);
    const spawn = vi.fn<(a: SpawnWorkerArgs) => number | undefined>(() => 999);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: (id) => exits.delete(id),
      verifyLogPath: () => logPath
    });
    disp.reclaim();
    expect(spawn).toHaveBeenCalledTimes(1);
    const arg = spawn.mock.calls[0][0];
    expect(arg.mode).toBe('work');
    expect(arg.verifyFailure).toContain('FAIL some.test');
    expect(store.getTask(task.id)?.verifyAttempts).toBe(1);
    expect(store.getTask(task.id)?.status).toBe('running');
    expect(store.listEvents(task.id).some((e) => e.kind === 'verify_failed')).toBe(true);
    store.close();
  });

  it('exit ≠0 at cap → blocked, no fix run', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `c-${Math.random()}.db`), { now: () => clock.t });
    const { task, verifyRunId } = makeVerifyingTask(store);
    store.incrementVerifyAttempts(task.id); // 1
    store.incrementVerifyAttempts(task.id); // 2 == VERIFY_ATTEMPT_CAP
    const exits = new Map<number, WorkerExit>([[verifyRunId, { code: 1, signal: null }]]);
    const spawn = vi.fn(() => 999);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: (id) => exits.delete(id),
      verifyLogPath: () => join(TEST_DIR, 'missing.log')
    });
    disp.reclaim();
    expect(spawn).not.toHaveBeenCalled();
    expect(store.getTask(task.id)?.status).toBe('blocked');
    store.close();
  });

  it('exit==null (unknown) → fail-open to review with verify_skipped', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `d-${Math.random()}.db`), { now: () => clock.t });
    const { task } = makeVerifyingTask(store);
    // dead pid, no recorded exit, expired claim → enters reclaim with exit==null
    store.extendClaim(task.id, 'L', -1); // force-expire
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => false, // pid 200 "dead"
      spawnWorker: () => undefined,
      config: baseConfig(),
      workerExit: () => undefined,
      clearWorkerExit: () => undefined,
      verifyLogPath: () => join(TEST_DIR, 'v.log')
    });
    disp.reclaim();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(store.listEvents(task.id).some((e) => e.kind === 'verify_skipped')).toBe(true);
    store.close();
  });

  it('a verify run exiting code 3 routes through verify (fail), NOT review-required', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `e-${Math.random()}.db`), { now: () => clock.t });
    const { task, verifyRunId } = makeVerifyingTask(store);
    const logPath = join(TEST_DIR, 'v.log');
    writeFileSync(logPath, '=== verify: tests ===\n');
    const exits = new Map<number, WorkerExit>([[verifyRunId, { code: 3, signal: null }]]);
    const spawn = vi.fn(() => 999);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: (id) => exits.delete(id),
      verifyLogPath: () => logPath
    });
    disp.reclaim();
    // code 3 must be treated as a verify FAILURE (fix run), not a review-required block
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(store.getTask(task.id)?.status).toBe('running');
    store.close();
  });
});
```

> Confirm the store exposes `listEvents(taskId)` returning rows with a `kind` field. If the accessor is named differently (e.g. `events(taskId)`), adjust the assertions to match. Find it with: `grep -nE "listEvents|events\(" src/main/kanban/kanban-store.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher-verify.test.ts`
Expected: FAIL (`verifyLogPath` not on deps; no verify branch).

- [ ] **Step 3: Extend the dispatcher types + const**

In `src/main/kanban/kanban-dispatcher.ts`:

Add to `SpawnWorkerArgs`:
```ts
  /** Prior verify failure output, injected into the work prompt for a verify-fix run. */
  verifyFailure?: string;
```

Add to `DispatcherDeps` (after `clearWorkerExit?`):
```ts
  /** runId-deterministic verify log path; the dispatcher reads the tail for the failure comment. */
  verifyLogPath?: (runId: number) => string;
```

Add a const near `RESOLVE_ATTEMPT_CAP`:
```ts
const VERIFY_ATTEMPT_CAP = 2;
```

- [ ] **Step 4: Insert the verify branch in `reclaim()`**

Immediately after the `suggest` branch's closing `}` (the block ending with `this.store.deleteTask(task.id); continue; }` around line 168), insert:

```ts
      // A terminal verify run: read the shell exit code as pass/fail BEFORE the
      // agent-oriented exit-3 / blockNow branches below (test runners routinely
      // exit 3, which REVIEW_REQUIRED would otherwise misread).
      if (reclaimMode === 'verify') {
        const runId = task.currentRunId;
        if (exit == null) {
          // unknown outcome (dead pid / expired / app-restart with empty map) → fail open
          if (runId != null) this.store.finishRun(runId, 'reclaimed', { error: 'verify outcome unknown' });
          this.reviewFromVerify(task, 'verify outcome unknown');
        } else if (exit.code === 0) {
          if (runId != null) this.store.finishRun(runId, 'completed');
          this.reviewFromVerify(task, null);
        } else {
          const label = this.lastVerifyLabel(runId);
          if (runId != null) {
            this.store.finishRun(runId, 'failed', { error: `verify failed: ${label} (exit ${exit.code})` });
          }
          if (task.verifyAttempts >= VERIFY_ATTEMPT_CAP) {
            const note = `verify failed after ${VERIFY_ATTEMPT_CAP} attempt(s): ${label}`;
            this.store.blockTask(task.id, note);
            this.store.appendEvent(task.id, runId, 'blocked', { reason: note });
            log.warn('verify gave up', { taskId: task.id, label });
          } else {
            const tail = runId != null && this.deps.verifyLogPath
              ? readLogTail(this.deps.verifyLogPath(runId))
              : '';
            this.store.addComment(
              task.id,
              'verify',
              `verify failed: ${label} ✗\n${tail}` +
                (runId != null && this.deps.verifyLogPath ? `\n(full log: ${this.deps.verifyLogPath(runId)})` : '')
            );
            this.store.appendEvent(task.id, runId, 'verify_failed', { label });
            this.spawnVerifyFix(task, tail);
          }
        }
        if (runId != null) this.deps.clearWorkerExit?.(runId);
        continue;
      }
```

Add `readLogTail` to the imports from `./spawn-worker` at the top of the dispatcher (find the existing `import { ... } from './spawn-worker'` line; if none, add `import { readLogTail } from './spawn-worker';`). Confirm `finalizeWorktree` is NOT needed here.

- [ ] **Step 5: Add the helper methods**

Add as private methods on `KanbanDispatcher` (near `spawnResolve`):

```ts
  /** Move a task from a finished verify run into review, recovering the work run's summary. */
  private reviewFromVerify(task: Task, skipReason: string | null): void {
    const work = this.store.listRuns(task.id).find((r) => r.mode === 'work' && r.outcome === 'completed');
    const summary = work?.summary ?? null;
    this.store.reviewTask(task.id, summary);
    if (task.repoPath && task.branchName && task.baseBranch) {
      const c = this.ops.checkMergeConflicts({
        repoPath: task.repoPath,
        baseBranch: task.baseBranch,
        branchName: task.branchName
      });
      this.store.setTaskConflict(task.id, c.state, c.files);
    }
    if (skipReason) {
      this.store.appendEvent(task.id, null, 'verify_skipped', { reason: skipReason });
    } else {
      const labels = this.verifyLabelsFor(task);
      this.store.appendEvent(task.id, null, 'verify_passed', { labels });
    }
  }

  /** The verify command labels configured for a task's project (for the verify_passed event). */
  private verifyLabelsFor(task: Task): string[] {
    if (!task.repoPath) return [];
    const project = this.store.getProjectByPath(task.boardId, task.repoPath);
    return (project?.verifyCommands ?? []).map((c) => c.label);
  }

  /** The label of the last verify command that started (= the one that failed), parsed from the log. */
  private lastVerifyLabel(runId: number | null): string {
    if (runId == null || !this.deps.verifyLogPath) return 'verify';
    const tail = readLogTail(this.deps.verifyLogPath(runId));
    const matches = [...tail.matchAll(/=== verify: (.+?) ===/g)];
    return matches.length ? matches[matches.length - 1][1] : 'verify';
  }

  /** Spawn a fresh `work` run on the same worktree to fix a verify failure. */
  private spawnVerifyFix(task: Task, failureTail: string): boolean {
    const lock = this.nextLock();
    if (!this.store.claimForVerifyFix(task.id, lock, this.deps.config.claimTtlMs)) return false;
    let runId: number | null = null;
    try {
      const workspace = task.workspacePath ?? '';
      const run = this.store.startRun(task.id, task.assignee ?? 'worker', null, 'work');
      runId = run.id;
      this.store.incrementVerifyAttempts(task.id);
      const pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode: 'work', verifyFailure: failureTail });
      if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
      this.store.appendEvent(task.id, run.id, 'spawned', {
        pid: pid ?? null,
        mode: 'work',
        reason: 'verify-fix',
        attempt: task.verifyAttempts + 1
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.recordFailure(task.id, msg);
      if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
      this.store.setStatusCleared(task.id, 'ready');
      log.error('verify-fix spawn failed', { taskId: task.id, error: msg });
      return false;
    }
  }
```

Confirm `Task` is imported in the dispatcher (it is — used throughout). Confirm `this.ops.checkMergeConflicts` is the injected `IntegrationOps` member (it is — see `DEFAULT_INTEGRATION_OPS`).

- [ ] **Step 6: Run the tests + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher-verify.test.ts`
Expected: PASS (all 5).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher-verify.test.ts
git commit -m "feat(kanban): reclaim() verify branch + spawnVerifyFix

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Gated `kanban_complete` in the MCP server

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Test: `src/main/__tests__/kanban-mcp-verify.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/kanban-mcp-verify.test.ts`. It reuses the `rpc` HTTP helper + `KanbanMcpServer` harness from `kanban-mcp-server.test.ts`, and a `makeRepo` git fixture (so `finalizeWorktree` has a real git dir):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanMcpServer, type VerifyRunner } from '../kanban/kanban-mcp-server';

const TEST_DIR = join(tmpdir(), `fleet-mcp-verify-${Date.now()}`);

async function rpc(url: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

function makeRepo(name: string): string {
  const repo = join(TEST_DIR, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}

describe('kanban_complete verify gate', () => {
  let store: KanbanStore;
  let server: KanbanMcpServer;
  let base: string;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(join(TEST_DIR, `v-${Math.random()}.db`));
    server = new KanbanMcpServer(store);
    base = `http://127.0.0.1:${await server.start(0)}/mcp`;
  });
  afterEach(async () => {
    await server.stop();
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function worktreeTask(repo: string) {
    const t = store.createTask({
      title: 'x',
      status: 'ready',
      assignee: 'r',
      workspaceKind: 'worktree',
      workspacePath: repo,
      repoPath: repo,
      branchName: 'kanban/x',
      baseBranch: 'main'
    });
    store.claimTask(t.id, 'LOCK', 100000);
    const run = store.startRun(t.id, 'r', 1, 'work');
    server.registerRun('tok', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    return t;
  }

  it('starts a verify run and holds the task in running when the project has verify_commands', async () => {
    const repo = makeRepo('gated');
    const p = store.addProject({ boardId: 'default', name: 'app', path: repo });
    store.setProjectVerifyCommands(p.id, [{ label: 'tc', command: 'true' }]);
    const t = worktreeTask(repo);

    let seen: Parameters<VerifyRunner>[0] | null = null;
    server.setVerifyRunner((args) => {
      seen = args;
      return 4242;
    });

    const r = await rpc(`${base}?run=tok`, 'tools/call', {
      name: 'kanban_complete',
      arguments: { summary: 's' }
    });
    expect(String(r.result.content[0].text)).toMatch(/verifying/i);
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('running');
    expect(after.workerPid).toBe(4242);
    expect(after.currentRunId != null && store.runMode(after.currentRunId)).toBe('verify');
    expect(seen?.commands).toEqual([{ label: 'tc', command: 'true' }]);
    expect(seen?.workspace).toBe(repo);
  });

  it('lands the task in review (old path) when the project has no verify_commands', async () => {
    const repo = makeRepo('ungated');
    store.addProject({ boardId: 'default', name: 'app', path: repo }); // no verify commands
    const t = worktreeTask(repo);
    server.setVerifyRunner(() => 4242); // present but must not be used

    await rpc(`${base}?run=tok`, 'tools/call', { name: 'kanban_complete', arguments: { summary: 's' } });
    expect(store.getTask(t.id)?.status).toBe('review');
  });
});
```

> If `createTask` doesn't accept `branchName`/`baseBranch` directly, set them via the store's workspace setter (`grep -nE "setWorkspace|branchName" src/main/kanban/kanban-store.ts`) after creation. Confirm `server.stop()` exists (the existing harness uses it).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-mcp-verify.test.ts`
Expected: FAIL (`setVerifyRunner` missing).

- [ ] **Step 3: Add the `VerifyRunner` type + setter**

Near the top of `kanban-mcp-server.ts` (after the `RunScope` types):

```ts
/** Spawns a deterministic verify run for a worktree completion; returns its pid (undefined on spawn failure). */
export type VerifyRunner = (args: {
  runId: number;
  taskId: string;
  workspace: string;
  commands: VerifyCommand[];
}) => number | undefined;
```

Add `VerifyCommand` to the `kanban-types` import list.

Add the field + setter alongside `commands`/`setCommands`:
```ts
  private verifyRunner: VerifyRunner | null = null;
```
```ts
  /** Inject the deterministic verify runner (spawns the verify shell; wired in index.ts over workerExits). */
  setVerifyRunner(runner: VerifyRunner): void {
    this.verifyRunner = runner;
  }
```

- [ ] **Step 4: Gate `kanban_complete`**

In the `kanban_complete` handler, inside the `if (task.workspaceKind === 'worktree' && task.workspacePath) { ... }` block, **before** the existing `this.store.reviewTask(task.id, a.summary);` line, add the gate. The structure becomes:

```ts
          if (task.workspaceKind === 'worktree' && task.workspacePath) {
            finalizeWorktree({ workspacePath: task.workspacePath, taskId: task.id, title: task.title });
            const stat = reviewStat({ workspacePath: task.workspacePath, baseBranch: task.baseBranch });
            const statText = stat
              ? `${stat.files} file${stat.files === 1 ? '' : 's'} (+${stat.insertions}/−${stat.deletions})`
              : 'changes committed';
            const where = task.branchName ?? `kanban/${task.id}`;

            // Deterministic verify gate (#231): only for genuine worktree diffs (work/resolve),
            // and only when the task's project has verify commands.
            const project =
              task.repoPath ? this.store.getProjectByPath(task.boardId, task.repoPath) : null;
            const commands = project?.verifyCommands ?? [];
            const gated =
              (scope.mode === 'work' || scope.mode === 'resolve') && commands.length > 0;

            if (gated && this.verifyRunner) {
              // Persist the work summary and free the work run row, but do NOT emit a
              // 'completed' event (it would fire a premature "Completed" notification).
              this.store.finishRun(scope.runId, 'completed', {
                summary: a.summary,
                metadata: { ...a.metadata, review: stat ?? undefined }
              });
              this.store.appendEvent(task.id, scope.runId, 'verify_started', {});
              const verify = this.store.startRun(task.id, null, null, 'verify');
              const pid = this.verifyRunner({
                runId: verify.id,
                taskId: task.id,
                workspace: task.workspacePath,
                commands
              });
              if (pid != null) {
                this.store.setWorkerPid(task.id, verify.id, pid);
                const lock = this.claimLocks.get(token);
                if (lock) this.store.extendClaim(task.id, lock, 15 * 60 * 1000);
                this.store.addComment(task.id, author, `verifying: ${statText} on ${where}`);
                this.unregisterRun(token);
                return this.text(res, rpcReq.id, `Task ${task.id} committed; verifying.`);
              }
              // Spawn failed → close the orphaned verify run and fail open to review.
              this.store.finishRun(verify.id, 'spawn_failed');
              this.store.reviewTask(task.id, a.summary);
              if (task.repoPath && task.branchName && task.baseBranch) {
                const c = checkMergeConflicts({ repoPath: task.repoPath, baseBranch: task.baseBranch, branchName: task.branchName });
                this.store.setTaskConflict(task.id, c.state, c.files);
              }
              this.store.appendEvent(task.id, verify.id, 'verify_skipped', { reason: 'verify spawn failed' });
              this.store.addComment(task.id, author, `review-required: ${statText} on ${where}`);
              this.unregisterRun(token);
              return this.text(res, rpcReq.id, `Task ${task.id} ready for review.`);
            }

            // Ungated path (unchanged behavior).
            this.store.reviewTask(task.id, a.summary);
            if (task.repoPath && task.branchName && task.baseBranch) {
              const c = checkMergeConflicts({ repoPath: task.repoPath, baseBranch: task.baseBranch, branchName: task.branchName });
              this.store.setTaskConflict(task.id, c.state, c.files);
            }
            this.store.finishRun(scope.runId, 'completed', {
              summary: a.summary,
              metadata: { ...a.metadata, review: stat ?? undefined }
            });
            this.store.appendEvent(task.id, scope.runId, 'completed', { summary: a.summary });
            this.store.addComment(task.id, author, `review-required: ${statText} on ${where}`);
            this.unregisterRun(token);
            return this.text(res, rpcReq.id, `Task ${task.id} ready for review.`);
          }
```

This restructures the existing worktree branch — preserve every existing side effect on the ungated path (the original code already did finalizeWorktree → reviewStat → reviewTask → setTaskConflict → finishRun → appendEvent('completed') → addComment → unregisterRun). Diff carefully against the original (lines ~974-1006) so the ungated path is behavior-identical.

- [ ] **Step 5: Run the test + full MCP suite + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-mcp-verify.test.ts src/main/__tests__/kanban-mcp-server.test.ts`
Expected: PASS (new tests + no regression in the existing suite).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-verify.test.ts
git commit -m "feat(kanban): gate kanban_complete behind a verify run

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `verify_commands` on project registration (MCP + commands)

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/main/__tests__/kanban-commands.test.ts` (match its existing harness for constructing `KanbanCommands` + a temp store + a temp dir for the project path):

```ts
it('addProject persists verify_commands and setProjectVerifyCommands updates them', () => {
  // const { commands, store } = makeCommands();  // use the file's existing helper
  const dir = mkdtempSync(join(tmpdir(), 'verify-proj-'));
  const p = commands.addProject({
    boardId: 'default',
    name: 'app',
    path: dir,
    verifyCommands: [{ label: 'typecheck', command: 'npm run typecheck' }]
  });
  expect(p.verifyCommands).toEqual([{ label: 'typecheck', command: 'npm run typecheck' }]);
  commands.setProjectVerifyCommands(p.id, [{ label: 'tests', command: 'npm test' }]);
  expect(store.getProject(p.id)?.verifyCommands).toEqual([{ label: 'tests', command: 'npm test' }]);
});
```

(Add `mkdtempSync`, `tmpdir`, `join` imports if the file lacks them.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `KanbanCommands.addProject` + add `setProjectVerifyCommands`**

In `kanban-commands.ts`, change the `addProject` input type and the final store call:

```ts
  addProject(input: {
    boardId: string;
    name: string;
    path: string;
    description?: string | null;
    verifyCommands?: VerifyCommand[];
  }): Project {
```

…and the return line:

```ts
    const project = this.store.addProject({ boardId: input.boardId, name, path: input.path, description });
    if (input.verifyCommands && input.verifyCommands.length > 0) {
      this.store.setProjectVerifyCommands(project.id, input.verifyCommands);
      return this.store.getProject(project.id) ?? project;
    }
    return project;
```

Add the edit-channel method:

```ts
  setProjectVerifyCommands(projectId: string, commands: VerifyCommand[]): void {
    if (!this.store.getProject(projectId)) throw new CodedError(`project not found: ${projectId}`, 'NOT_FOUND');
    this.store.setProjectVerifyCommands(projectId, commands);
  }
```

Import `VerifyCommand` from the shared types in `kanban-commands.ts`.

- [ ] **Step 4: Accept `verify_commands` in the MCP `kanban_project_add` tool**

In `kanban-mcp-server.ts`, the `kanban_project_add` tool declaration `inputSchema.properties`, add:
```ts
        verify_commands: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, command: { type: 'string' } },
            required: ['label', 'command']
          }
        },
```

In the `case 'kanban_project_add':` handler, extend the zod parse + the `addProject` call:
```ts
          const a = z
            .object({
              name: z.string(),
              path: z.string(),
              description: z.string().optional(),
              verify_commands: z
                .array(z.object({ label: z.string().min(1), command: z.string().min(1) }))
                .optional()
            })
            .parse(args);
          const p = commands.addProject({
            boardId: scope.boardId,
            name: a.name,
            path: a.path,
            description: a.description ?? null,
            verifyCommands: a.verify_commands
          });
```

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): verify_commands on project add + edit channel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire the verify runner + dispatcher dep in `index.ts`

**Files:**
- Modify: `src/main/index.ts`

No unit test (integration wiring); verified by `npm run build` + `npm run typecheck`. Trace the data flow by reading once before editing.

- [ ] **Step 1: Add the `verifyLogPath` helper + pass `verifyFailure` through the `spawnWorker` closure**

In `src/main/index.ts`, near where `KANBAN_HOME` is defined (line ~804), add:
```ts
  const verifyLogPath = (runId: number): string => join(KANBAN_HOME, 'logs', `verify-${runId}.log`);
```

In the `spawnWorker` dep closure, change the destructure to include `verifyFailure`:
```ts
    spawnWorker: ({ task, runId, lock, workspace, mode, verifyFailure }) => {
```
and pass it into the `spawnRuneWorker(...)` `BuildWorkerInput` object (alongside `resolveTarget`):
```ts
          resolveTarget,
          verifyFailure,
```

- [ ] **Step 2: Add the `verifyLogPath` dep to the dispatcher construction**

In the `new KanbanDispatcher(kanbanStore, { ... })` deps object (ends ~line 1075 with `clearWorkerExit`), add:
```ts
    verifyLogPath,
```

- [ ] **Step 3: Wire the verify runner into the MCP server**

After the existing `kanbanMcp.setSwarmHandler(...)` / `setCommands(...)` / `setKanbanHome(...)` block (~line 1090), add (it must close over `workerExits` and `KANBAN_HOME`, both in scope there):

```ts
  kanbanMcp.setVerifyRunner(({ runId, taskId, workspace, commands }) => {
    const logPath = verifyLogPath(runId);
    return spawnVerify({ workspace, commands, logPath }, (exit) => {
      // Raw recorder: NO rune auth/crash classification (a test exit-3 or a "401" in
      // output must not be misread as a fatal block). Same guard as the rune recorder so
      // a late exit (after reclaim already fail-opened) can't leave a stale entry.
      const t = kanbanStore!.getTask(taskId);
      if (t?.status !== 'running' || t.currentRunId !== runId) return;
      workerExits.set(runId, { code: exit.code, signal: exit.signal });
    });
  });
```

Add `spawnVerify` to the existing `import { ... } from './kanban/spawn-worker'` line in `index.ts`.

> Note the `WorkerExit` (dispatcher) shape is `{ code, signal, fatalReason?, blockNow? }` with the latter two optional, so a raw `{ code, signal }` is assignable. The `signal` from `spawnVerify`'s `WorkerExit` is `NodeJS.Signals | null`; assign as-is.

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build`
Expected: PASS (electron-vite build succeeds).

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(kanban): wire verify runner (raw recorder) + verifyLogPath dep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Projects dialog verify-commands editor (IPC + UI)

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/main/kanban/kanban-ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/components/kanban/ProjectsModal.tsx`

No new vitest (UI). Verified by typecheck + build + a manual smoke note.

- [ ] **Step 1: Add the IPC channel**

In `src/shared/ipc-channels.ts`, after `KANBAN_SET_DEFAULT_PROJECT`:
```ts
  KANBAN_SET_PROJECT_VERIFY: 'kanban:set-project-verify',
```

- [ ] **Step 2: Extend `KanbanAddProjectRequest`**

In `src/shared/ipc-api.ts`, in the `KanbanAddProjectRequest` type, add (importing `VerifyCommand` if needed):
```ts
  verifyCommands?: VerifyCommand[];
```

- [ ] **Step 3: Add the main-process handler**

In `src/main/kanban/kanban-ipc.ts`, in the `// ---- Projects ----` block, after the `KANBAN_SET_DEFAULT_PROJECT` handler:
```ts
  ipcMain.handle(
    IPC_CHANNELS.KANBAN_SET_PROJECT_VERIFY,
    (_e, id: string, verifyCommands: VerifyCommand[]) => {
      commands.setProjectVerifyCommands(id, verifyCommands ?? []);
    }
  );
```

> `commands` is the command-layer variable the sibling project handlers already close over (`commands.addProject`, `commands.removeProject`). Match that exact name. Import `VerifyCommand` from the shared types at the top of `kanban-ipc.ts`.

- [ ] **Step 4: Add the preload bridge**

In `src/preload/index.ts`, in the kanban projects block after `setDefaultProject`:
```ts
    setProjectVerifyCommands: async (id: string, commands: VerifyCommand[]): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SET_PROJECT_VERIFY, id, commands),
```
Import `VerifyCommand` in the preload's type imports.

- [ ] **Step 5: Add the editor to `ProjectsModal`**

In `src/renderer/src/components/kanban/ProjectsModal.tsx`, for each listed project render a small editable list of `{label, command}` rows bound to `project.verifyCommands`, with add/remove-row buttons and a Save button that calls:
```ts
await window.fleet.kanban.setProjectVerifyCommands(project.id, rows.filter((r) => r.label.trim() && r.command.trim()));
await load(); // re-fetch projects (use the modal's existing loader name)
```
Include helper text: "Run in the task's worktree after completion, in order, stopping at the first failure. Prepend an install step (e.g. `npm ci`) if dependencies aren't already present." Match the modal's existing Tailwind/shadcn styling; keep it minimal (no new component file).

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts src/main/kanban/kanban-ipc.ts src/preload/index.ts src/renderer/src/components/kanban/ProjectsModal.tsx
git commit -m "feat(kanban): Projects dialog verify-commands editor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] **Full typecheck:** `npm run typecheck` → PASS
- [ ] **Full test suite:** `npx vitest run` → all pass, no regressions
- [ ] **Build:** `npm run build` → PASS
- [ ] **Lint (changed files only; repo lint is pre-existing-red):** `npx eslint <changed files>` → no NEW errors on your lines; in particular zero `as` casts / `eslint-disable` in `src` production files
- [ ] **Dispatch the final whole-implementation review** (subagent-driven-development final step).

## Spec coverage map

- Opt-in, no global flag → Task 5 gate (`commands.length > 0`), Task 2 (`verifyCommands` default `[]`).
- Labeled stop-on-first-failure → Task 3 `buildVerifyScript`.
- Verify run = deterministic run, no new TaskStatus → Tasks 3/5/7 (`RunMode 'verify'`, task stays `running`).
- reclaim pass/fail/cap/fail-open + exit-3 isolation → Task 4 (+ tests).
- Summary recovery before `finishRun(verify)` → Task 4 `reviewFromVerify`.
- `orchestratorRunningCount` excludes verify → Task 2.
- Verify pid = `worker_pid`, `extendClaim` → Task 5.
- Raw exit recorder + running/currentRunId guard → Task 7.
- `verifyFailure` reaches fix worker via prompt → Tasks 3/4/7.
- Output: on-disk log + 8KB tail comment, no artifact → Task 4.
- `verifyLogPath` runId-deterministic dep → Tasks 4/7.
- Events `verify_started`/`verify_passed`/`verify_failed`/`verify_skipped`; cap→blocked notification → Tasks 4/5.
- Project add + edit channel → Tasks 6/8.
- v1: events only, no PR check surface → out of scope (noted in spec §9).
