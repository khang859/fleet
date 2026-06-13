# Kanban Agent Code Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an agent code-review stage that runs a reviewer LLM on a completed worktree task's diff, records a structured approve/request-changes verdict, bounces request-changes back to the worker (bounded), and gates feature auto-merge — all behind a global `autoReview` setting (default on).

**Architecture:** A new agent run mode `'review'` on the task's existing worktree, spawned by a new dispatcher stage `reviewTasks()` (claims `review`-status worktree tasks with no verdict), recorded by a terminal MCP tool `kanban_review_verdict` (record-only, like the verify run), and routed by a new `reclaim()` branch (approve → review; request_changes → bounce work-fix under a cap, else soft-escalate to human review). `integrate()` gains an approve-verdict guard + a HEAD-SHA stale-diff assertion. Mirrors the #231 verify-gate machinery throughout.

**Tech Stack:** TypeScript, better-sqlite3 (kanban store), a hand-rolled MCP HTTP server, the `rune` CLI worker, vitest. Electron main/renderer split.

**Spec:** `docs/superpowers/specs/2026-06-12-kanban-agent-review-design.md`

---

## Conventions (read once)

- **No `as` casts / no `eslint-disable` in `src` production code.** Use zod for runtime validation. Tests may cast. The only sanctioned cast is the existing raw-sqlite-row `Record<string, unknown>` in `kanban-store.ts`.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Run tests with** `npx vitest run <file>`; **typecheck with** `npm run typecheck` (vitest does NOT typecheck). After any `SCHEMA_VERSION` bump, run the FULL store suite (`npx vitest run src/main/__tests__/kanban-store.test.ts`) — a bump silently breaks version-pinned assertions (see `docs/learnings/2026-06-12-schema-bump-breaks-store-suite.md`).
- **Branch:** create `feat/kanban-agent-review` off `main` before Task 1. Do not work on `main`.

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `src/shared/kanban-types.ts` | `RunMode += 'review'`, `RunOutcome` unchanged, `ReviewVerdict` type, `Task` review fields | 1 |
| `src/shared/types.ts` | `WorkerProfile.role += 'reviewer'`, `REVIEWER_PROFILE_NAME`, `DEFAULT_REVIEWER_INSTRUCTIONS`, `KanbanSettings.dispatcher.autoReview` | 1, 3 |
| `src/shared/constants.ts` | `DEFAULT_SETTINGS.kanban.dispatcher.autoReview: true`, seed reviewer profile | 1, 3 |
| `src/main/kanban/schema.ts` | `SCHEMA_VERSION 15` + columns | 1 |
| `src/main/kanban/kanban-store.ts` | migration 15, `rowToTask` fields, review store methods, `isSwarmMember`, `reviewPendingTasks`, `orchestratorRunningCount` | 1, 2, 6 |
| `src/main/kanban/workspace.ts` | `headSha`, `worktreeDiff` helpers | 2 |
| `src/main/kanban/spawn-worker.ts` | `requireToolsForMode` review case, `buildPrompt` review + bounce blocks, `BuildWorkerInput` fields | 3 |
| `src/main/kanban/kanban-dispatcher.ts` | `DispatcherConfig.autoReview`, `SpawnWorkerArgs.reviewFindings`, `IntegrationOps.headSha`, `reviewTasks()`, reclaim review branch, `spawnReviewFix`, integrate guard | 2, 6, 7, 8 |
| `src/main/kanban/kanban-mcp-server.ts` | `kanban_review_verdict` tool, `REVIEW_TOOLS`, `toolsForMode`, mode-aware author, `review_ready` emit | 5 |
| `src/main/index.ts` | spawnWorker `review` branch, roster filter flip, `buildDispatcherConfig` autoReview, `headSha`/diff wiring | 4 |
| `src/shared/kanban-notifications.ts` | classify `review_*` kinds | 9 |
| `src/main/kanban/kanban-notifier.ts` | suppress gate-pass set when autoReview on (OS) | 9 |
| `src/renderer/src/hooks/useKanbanAttention.ts` | suppress gate-pass set when autoReview on (badge) | 9 |
| `src/renderer/.../KanbanSection.tsx` (Settings) + card/drawer badge | reviewer profile editor, review badge | 10 |

---

### Task 1: Types, settings, and schema migration 15

**Files:**
- Modify: `src/shared/kanban-types.ts` (`RunMode`, new `ReviewVerdict`, `Task` fields)
- Modify: `src/shared/types.ts` (`KanbanSettings.dispatcher.autoReview`)
- Modify: `src/shared/constants.ts` (`DEFAULT_SETTINGS.kanban.dispatcher.autoReview`)
- Modify: `src/main/kanban/schema.ts` (`SCHEMA_VERSION`, columns)
- Modify: `src/main/kanban/kanban-store.ts` (migration block, `rowToTask`)
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`DispatcherConfig.autoReview`)
- Test: `src/main/__tests__/kanban-review-store.test.ts` (new)

- [ ] **Step 1: Write the failing migration test**

Create `src/main/__tests__/kanban-review-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';

const db = () => join(tmpdir(), `fleet-review-${Math.random()}.db`);

describe('review schema (migration 15)', () => {
  it('is at schema version 15 with review columns defaulting correctly', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    expect(store.schemaVersion()).toBe(15);
    const t = store.createTask({ title: 'x' });
    const got = store.getTask(t.id)!;
    expect(got.reviewVerdict).toBeNull();
    expect(got.reviewAttempts).toBe(0);
    expect(got.reviewHeadSha).toBeNull();
    store.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-review-store.test.ts`
Expected: FAIL — `expected 14 to be 15` (and `reviewVerdict` undefined).

- [ ] **Step 3: Add the `RunMode` value, `ReviewVerdict`, and `Task` fields**

In `src/shared/kanban-types.ts`, add `'review'` to the `RunMode` union (keep it multiline/prettier-clean):

```ts
export type RunMode =
  | 'work'
  | 'decompose'
  | 'specify'
  | 'assign'
  | 'resolve'
  | 'suggest'
  | 'verify'
  | 'review';
```

Add the verdict type near `ConflictState`:

```ts
/** Agent code-review outcome recorded on a task (spec §232). */
export type ReviewVerdict = 'approve' | 'request_changes';
```

In the `Task` interface, after `verifyAttempts: number;` add:

```ts
  /** Agent code-review verdict; null until the reviewer runs (spec §232). */
  reviewVerdict: ReviewVerdict | null;
  /** Bounded review-fix budget; mirrors verifyAttempts. */
  reviewAttempts: number;
  /** Worktree HEAD captured when the reviewer approved; integrate merges only at this SHA. */
  reviewHeadSha: string | null;
```

- [ ] **Step 4: Add the `autoReview` setting type + default + dispatcher config field**

In `src/shared/types.ts`, in `KanbanSettings.dispatcher`, after the `autoIntegrate` line add:

```ts
    autoReview: boolean; // when true, runs an agent code-review gate before review/auto-merge
```

In `src/shared/constants.ts`, in `DEFAULT_SETTINGS.kanban.dispatcher` (after `autoIntegrate: true`) add:

```ts
      autoReview: true,
```

In `src/main/kanban/kanban-dispatcher.ts`, in `DispatcherConfig`, after the `autoIntegrate` line add:

```ts
  autoReview: boolean; // gate completed worktree tasks through an agent review run
```

- [ ] **Step 5: Bump the schema and add the migration**

In `src/main/kanban/schema.ts`, change `export const SCHEMA_VERSION = 14;` → `15`. In `SCHEMA_SQL`, in the `tasks` table after `verify_attempts INTEGER NOT NULL DEFAULT 0,` add:

```sql
  review_verdict TEXT,
  review_attempts INTEGER NOT NULL DEFAULT 0,
  review_head_sha TEXT,
```

In `src/main/kanban/kanban-store.ts` `migrate()`, after the `if (current < 14) { … }` block add:

```ts
    if (current < 15) {
      // Agent code review (#232): per-task verdict, bounded review-fix budget,
      // and the approved HEAD sha that integrate merges. Additive, idempotent.
      this.addColumnIfMissing('tasks', 'review_verdict', 'TEXT');
      this.addColumnIfMissing('tasks', 'review_attempts', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('tasks', 'review_head_sha', 'TEXT');
    }
```

In `rowToTask`, after the `verifyAttempts: Number(r.verify_attempts ?? 0),` line add:

```ts
      reviewVerdict: (r.review_verdict as Task['reviewVerdict']) ?? null,
      reviewAttempts: Number(r.review_attempts ?? 0),
      reviewHeadSha: (r.review_head_sha as string | null) ?? null,
```

- [ ] **Step 6: Run the new test + the FULL store suite**

Run: `npx vitest run src/main/__tests__/kanban-review-store.test.ts`
Expected: PASS.

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS. If any assertion reads `schemaVersion()).toBe(14)`, update it to `15` (replace_all) and re-run — this is the documented schema-bump trap.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (The `pm-agents.test.ts`/swarm tests construct `KanbanSettings` — if any literal omits `autoReview`, add `autoReview: true` to it. The `Task` object is built only by `rowToTask`, so no other construction sites need the new fields.)

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(kanban): schema 15 + types for agent review (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Store methods + workspace git helpers + IntegrationOps.headSha

**Files:**
- Modify: `src/main/kanban/kanban-store.ts` (claim/verdict/attempt mutators, `reviewPendingTasks`, `isSwarmMember`, `orchestratorRunningCount`)
- Modify: `src/main/kanban/workspace.ts` (`headSha`, `worktreeDiff`)
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`IntegrationOps.headSha`, `DEFAULT_INTEGRATION_OPS`)
- Test: `src/main/__tests__/kanban-review-store.test.ts` (extend)

- [ ] **Step 1: Write failing tests for the store methods**

Append to `src/main/__tests__/kanban-review-store.test.ts`:

```ts
describe('review store methods', () => {
  it('claimForReview flips a review task to running, CAS on status', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = store.createTask({ title: 'x', status: 'review', workspaceKind: 'worktree' });
    expect(store.claimForReview(t.id, 'L1', 10000)).toBe(true);
    expect(store.getTask(t.id)!.status).toBe('running');
    expect(store.getTask(t.id)!.claimLock).toBe('L1');
    // not in review anymore → second claim fails
    expect(store.claimForReview(t.id, 'L2', 10000)).toBe(false);
    store.close();
  });

  it('setReviewVerdict / increment / reset / clear', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = store.createTask({ title: 'x' });
    store.setReviewVerdict(t.id, 'approve', 'abc123');
    expect(store.getTask(t.id)!.reviewVerdict).toBe('approve');
    expect(store.getTask(t.id)!.reviewHeadSha).toBe('abc123');
    store.incrementReviewAttempts(t.id);
    store.incrementReviewAttempts(t.id);
    expect(store.getTask(t.id)!.reviewAttempts).toBe(2);
    store.resetReviewAttempts(t.id);
    expect(store.getTask(t.id)!.reviewAttempts).toBe(0);
    store.setReviewVerdict(t.id, 'request_changes');
    store.clearReviewVerdict(t.id);
    expect(store.getTask(t.id)!.reviewVerdict).toBeNull();
    expect(store.getTask(t.id)!.reviewHeadSha).toBeNull();
    store.close();
  });

  it('reviewPendingTasks selects review worktree tasks with no verdict, skips system/scratch/verdicted', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const ok = store.createTask({ title: 'ok', status: 'review', workspaceKind: 'worktree' });
    store.setWorkspace(ok.id, '/tmp/wt', 'b', 'main');
    store.createTask({ title: 'scratch', status: 'review', workspaceKind: 'scratch' });
    const sys = store.createTask({ title: 'sys', status: 'review', workspaceKind: 'worktree', systemKind: 'feature_sync' });
    store.setWorkspace(sys.id, '/tmp/wt2', 'b', 'main');
    const verdicted = store.createTask({ title: 'v', status: 'review', workspaceKind: 'worktree' });
    store.setWorkspace(verdicted.id, '/tmp/wt3', 'b', 'main');
    store.setReviewVerdict(verdicted.id, 'approve', 'sha');
    const ids = store.reviewPendingTasks().map((t) => t.id);
    expect(ids).toContain(ok.id);
    expect(ids).not.toContain(sys.id);
    expect(ids).not.toContain(verdicted.id);
    store.close();
  });

  it('orchestratorRunningCount excludes review runs', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = store.createTask({ title: 'x', status: 'running' });
    const run = store.startRun(t.id, 'reviewer', 1, 'review');
    store.setWorkerPid(t.id, run.id, 1);
    expect(store.orchestratorRunningCount()).toBe(0);
    store.close();
  });

  it('isSwarmMember is false for an ordinary task and does not hang on a link cycle', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    store.addLink(a.id, b.id);
    store.addLink(b.id, a.id); // cycle
    expect(store.isSwarmMember(b.id)).toBe(false); // terminates (seen-set guard), no swarm root
    store.close();
  });
  // The true case (a child linked under a kanban_swarm_v1 root) is covered by the swarm
  // helper's own isSwarmRoot tests; reviewTasks() (Task 6) mocks isSwarmMember to exercise skipping.
});
```

> Note: confirm `setWorkspace(taskId, path, branch, base)` is the real signature (it is — used in `index.ts:900`). If the test helper signature differs, match the store.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-review-store.test.ts`
Expected: FAIL — `claimForReview is not a function`.

- [ ] **Step 3: Implement the store methods**

In `src/main/kanban/kanban-store.ts`, add near `claimForVerifyFix` (mirroring `claimForResolve`):

```ts
  /** CAS-claim a review-status worktree task for an agent review run; flips it to running. */
  claimForReview(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='running', claim_lock=@lock, claim_expires=@expires,
           last_heartbeat_at=@ts, updated_at=@ts
         WHERE id=@id AND status='review'
           AND (claim_lock IS NULL OR claim_expires <= @ts)`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }
```

Add the verdict/attempt mutators near `resetVerifyAttempts`:

```ts
  /** Record the agent review verdict; capture the approved HEAD sha on approve. */
  setReviewVerdict(taskId: string, decision: ReviewVerdict, headSha?: string | null): void {
    this.db
      .prepare(
        'UPDATE tasks SET review_verdict=@v, review_head_sha=@sha, updated_at=@ts WHERE id=@id'
      )
      .run({ id: taskId, v: decision, sha: headSha ?? null, ts: this.now() });
  }

  incrementReviewAttempts(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET review_attempts = review_attempts + 1, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  resetReviewAttempts(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET review_attempts = 0, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  /** Null the verdict + approved sha (a fresh diff invalidates a prior verdict). Leaves attempts untouched. */
  clearReviewVerdict(taskId: string): void {
    this.db
      .prepare(
        'UPDATE tasks SET review_verdict=NULL, review_head_sha=NULL, updated_at=? WHERE id=?'
      )
      .run(this.now(), taskId);
  }

  /** Review-status worktree tasks awaiting an agent verdict (candidates for reviewTasks()). */
  reviewPendingTasks(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status='review' AND workspace_kind='worktree' AND workspace_path IS NOT NULL
           AND review_verdict IS NULL AND system_kind IS NULL
         ORDER BY priority DESC, created_at ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }
```

> **Attempt-counter ownership (spec §5 lifecycle):** `clearReviewVerdict` nulls verdict+sha ONLY (it does not touch attempts). New-episode sites (Task 7: claimAndSpawn from ready, spawnResolve) call `resetReviewAttempts` explicitly alongside it; the bounce path (Task 7: spawnReviewFix) calls `clearReviewVerdict` then `incrementReviewAttempts`. This keeps the per-episode counter correct.

Add `isSwarmMember` (uses the already-exported `isSwarmRoot` from `kanban-swarm.ts`). At the top of `kanban-store.ts`, add to the existing `kanban-swarm` import (or add an import) `isSwarmRoot`:

```ts
import { isSwarmRoot } from './kanban-swarm';
```

Then add the method:

```ts
  /** True when the task is part of a swarm graph (linked up to a swarm root). */
  isSwarmMember(taskId: string): boolean {
    const seen = new Set<string>();
    let frontier = [taskId];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (isSwarmRoot(this, id)) return true;
        for (const p of this.parentsOf(id)) next.push(p);
      }
      frontier = next;
    }
    return false;
  }
```

Update `orchestratorRunningCount` to also exclude `'review'`:

```ts
         WHERE t.status='running' AND r.mode NOT IN ('work','verify','review')`
```

> Ensure `ReviewVerdict` is imported in `kanban-store.ts`'s type import from `../../shared/kanban-types`.

- [ ] **Step 4: Run the store tests**

Run: `npx vitest run src/main/__tests__/kanban-review-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Add workspace git helpers (test)**

Create `src/main/__tests__/kanban-review-workspace.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { headSha, worktreeDiff } from '../kanban/workspace';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'fleet-ws-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('workspace git helpers', () => {
  it('headSha returns the current HEAD sha', () => {
    expect(headSha(repo)).toMatch(/^[0-9a-f]{40}$/);
  });
  it('worktreeDiff returns the diff vs base', () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    execFileSync('git', ['-C', repo, 'commit', '-aqm', 'change']);
    const diff = worktreeDiff({ workspacePath: repo, baseBranch: 'main', maxBytes: 10000 });
    expect(diff).toContain('a.txt');
  });
  it('worktreeDiff caps output and marks truncation', () => {
    writeFileSync(join(repo, 'big.txt'), 'x\n'.repeat(5000));
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'big']);
    const diff = worktreeDiff({ workspacePath: repo, baseBranch: 'main', maxBytes: 200 });
    expect(diff.length).toBeLessThan(400);
    expect(diff).toContain('truncated');
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-review-workspace.test.ts`
Expected: FAIL — `headSha is not a function`.

- [ ] **Step 7: Implement the helpers**

In `src/main/kanban/workspace.ts` (mirroring `reviewStat`, which already uses `execFileSync` + `try/catch`):

```ts
/** Current HEAD sha of a worktree, or null on error. */
export function headSha(workspacePath: string): string | null {
  try {
    return execFileSync('git', ['-C', workspacePath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8'
    }).trim();
  } catch {
    return null;
  }
}

/** Diff of a worktree branch vs its base, byte-capped with a truncation marker; '' on error. */
export function worktreeDiff(input: {
  workspacePath: string;
  baseBranch: string | null;
  maxBytes?: number;
}): string {
  if (!input.baseBranch) return '';
  const cap = input.maxBytes ?? 60000;
  try {
    const out = execFileSync(
      'git',
      ['-C', input.workspacePath, 'diff', `${input.baseBranch}...HEAD`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    if (out.length <= cap) return out;
    return out.slice(0, cap) + '\n… (diff truncated)';
  } catch {
    return '';
  }
}
```

- [ ] **Step 8: Add `headSha` to `IntegrationOps`**

In `src/main/kanban/kanban-dispatcher.ts`: add `headSha` to the `workspace` import list, then to `IntegrationOps` and `DEFAULT_INTEGRATION_OPS`:

```ts
// import: add headSha to the existing { … } from './workspace'
export interface IntegrationOps {
  // …existing…
  headSha: typeof headSha;
}
const DEFAULT_INTEGRATION_OPS: IntegrationOps = {
  // …existing…
  headSha
};
```

- [ ] **Step 9: Run workspace tests + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-review-workspace.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS. (Any test constructing a partial `IntegrationOps` must add `headSha`. Search `integration:` in dispatcher tests; the existing ones pass a partial — add `headSha: () => 'sha'` where a test injects `integration`.)

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(kanban): review store methods + workspace git helpers (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Reviewer profile + worker-prompt review/bounce blocks

**Files:**
- Modify: `src/shared/types.ts` (`role += 'reviewer'`, `REVIEWER_PROFILE_NAME`, `DEFAULT_REVIEWER_INSTRUCTIONS`)
- Modify: `src/main/kanban/spawn-worker.ts` (`requireToolsForMode`, `buildPrompt`, `BuildWorkerInput`)
- Test: `src/main/__tests__/kanban-review-spawn.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `src/main/__tests__/kanban-review-spawn.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildWorkerInvocation } from '../kanban/spawn-worker';
import { REVIEWER_PROFILE_NAME, DEFAULT_REVIEWER_INSTRUCTIONS } from '../../shared/types';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ws = () => mkdtempSync(join(tmpdir(), 'fleet-spawn-'));
const baseTask = { id: 't1', title: 'T', body: 'B', assignee: 'w', modelOverride: null };

describe('review run prompt + tools', () => {
  it('review mode requires kanban_review_verdict and injects the diff', () => {
    const inv = buildWorkerInvocation({
      task: baseTask,
      workspace: ws(),
      mcpPort: 1,
      runToken: 'tok',
      logPath: '/tmp/x.log',
      mode: 'review',
      reviewDiff: 'diff --git a/x b/x\n+changed'
    });
    expect(inv.args).toContain('--require-tool');
    expect(inv.args[inv.args.indexOf('--require-tool') + 1]).toBe('kanban_review_verdict');
    const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
    expect(prompt).toContain('diff --git a/x b/x');
    expect(prompt).toContain('kanban_review_verdict');
  });

  it('work mode injects prior review findings (the bounce)', () => {
    const inv = buildWorkerInvocation({
      task: baseTask,
      workspace: ws(),
      mcpPort: 1,
      runToken: 'tok',
      logPath: '/tmp/x.log',
      mode: 'work',
      reviewFindings: '- x.ts: missing null check'
    });
    const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
    expect(prompt).toContain('missing null check');
    expect(prompt).toContain('review');
  });

  it('exports a reviewer profile name and default persona', () => {
    expect(REVIEWER_PROFILE_NAME).toBe('reviewer');
    expect(DEFAULT_REVIEWER_INSTRUCTIONS.length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-review-spawn.test.ts`
Expected: FAIL — `REVIEWER_PROFILE_NAME` not exported / `reviewDiff` not a valid field.

- [ ] **Step 3: Add the role + reviewer constants**

In `src/shared/types.ts`, change `WorkerProfile.role`:

```ts
  role: 'worker' | 'orchestrator' | 'reviewer'; // orchestrator drives decompose/specify; reviewer drives code-review runs
```

After `ORCHESTRATOR_PROFILE_NAME`/`DEFAULT_ORCHESTRATOR_INSTRUCTIONS`, add:

```ts
/** The single reviewer profile's reserved name. There is exactly one reviewer. */
export const REVIEWER_PROFILE_NAME = 'reviewer';

/**
 * Default persona for the singleton code reviewer. Complements the runtime review prompt
 * (which supplies the diff + the kanban_review_verdict call). Surfaced in Settings with a
 * "Reset to default" button, so it lives here where both main (seed) and renderer reach it.
 */
export const DEFAULT_REVIEWER_INSTRUCTIONS = `You are a senior code reviewer. Judge the diff strictly against the task's stated goal and acceptance criteria. Approve only when the change is correct, focused, and complete; otherwise request changes with specific, actionable findings (file + what to fix). Do not nitpick formatting or style that automated verify commands already enforce. Do not implement the work yourself.`;
```

- [ ] **Step 4: Add the `BuildWorkerInput` fields + `requireToolsForMode` case + prompt blocks**

In `src/main/kanban/spawn-worker.ts`, add to `BuildWorkerInput` (after `verifyFailure?: string;`):

```ts
  /** Unified diff of the worktree vs its base, injected into the review prompt. */
  reviewDiff?: string;
  /** Prior review findings, injected into a bounce work prompt so the fix worker sees them. */
  reviewFindings?: string;
```

In `requireToolsForMode`, add a case before `default`:

```ts
    case 'review':
      return 'kanban_review_verdict';
```

In `buildPrompt`, add a `review` branch (place it after the `suggest` branch, before the final work block):

```ts
  if (mode === 'review') {
    const diff = input.reviewDiff?.trim() || '(no diff available)';
    return (
      `review kanban task ${task.id}: ${task.title}\n\n${task.body}\n\n` +
      `You are reviewing the implementation below as a code reviewer. Judge it against the task ` +
      `goal and any acceptance criteria. When done, call kanban_review_verdict with decision ` +
      `'approve' or 'request_changes', a one-line summary, and (for request_changes) specific ` +
      `findings. Do not modify the code.\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``
    );
  }
```

In the final work block, prepend a review-findings section alongside the existing `verifyBlock`:

```ts
  const reviewBlock = input.reviewFindings
    ? `A code review requested changes on your previous completion. Address each finding and call ` +
      `kanban_complete again — it will be re-reviewed.\n\n\`\`\`\n${input.reviewFindings}\n\`\`\`\n\n`
    : '';
  return (
    reviewBlock +
    verifyBlock +
    `work kanban task ${task.id}: ${task.title}\n\n${task.body}` +
    // …unchanged…
```

- [ ] **Step 5: Run the spawn tests**

Run: `npx vitest run src/main/__tests__/kanban-review-spawn.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(kanban): reviewer profile + review/bounce worker prompts (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: index.ts spawnWorker review branch + roster flip + config wiring

**Files:**
- Modify: `src/main/index.ts` (spawnWorker closure, `buildDispatcherConfig`, roster filter)
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`SpawnWorkerArgs.reviewFindings`)

> This task has no direct unit test (the `deps.spawnWorker` closure is integration glue). Verify via typecheck + the dispatcher tests in Tasks 6–7 that drive `spawnWorker` as a mock. Read `src/main/index.ts:956-1073` before editing.

- [ ] **Step 1: Add `reviewFindings` to `SpawnWorkerArgs`**

In `src/main/kanban/kanban-dispatcher.ts`, in `SpawnWorkerArgs` (after `verifyFailure?: string;`):

```ts
  /** Prior review findings, injected into a bounce work prompt for a review-fix run. */
  reviewFindings?: string;
```

- [ ] **Step 2: Thread `reviewFindings` through the closure signature**

In `src/main/index.ts`, change the destructure on the `spawnWorker:` closure (line ~956):

```ts
    spawnWorker: ({ task, runId, lock, workspace, mode, verifyFailure, reviewFindings }) => {
```

- [ ] **Step 3: Add the `review` profile branch (no assignee write) + diff generation**

In the closure's profile-selection `if/else` (lines ~968-998), insert a `review` branch. Replace:

```ts
      if (mode === 'work' || mode === 'resolve') {
        const resolved = resolveWorkProfile(profiles, task.assignee);
        profile = resolved.profile;
        if (resolved.fellBack) { /* …log… */ }
      } else {
```

with:

```ts
      let reviewDiff: string | undefined;
      if (mode === 'work' || mode === 'resolve') {
        const resolved = resolveWorkProfile(profiles, task.assignee);
        profile = resolved.profile;
        if (resolved.fellBack) {
          log.warn('kanban: non-worker profile assigned to work task; using worker fallback', {
            taskId: task.id,
            assignee: task.assignee,
            fallback: profile?.name ?? null
          });
        }
      } else if (mode === 'review') {
        // Singleton reviewer; fall back to an in-memory default persona when absent
        // (existing users have no saved reviewer profile). NEVER write task.assignee.
        profile =
          profiles.find((p) => p.name === REVIEWER_PROFILE_NAME && p.role === 'reviewer') ?? {
            name: REVIEWER_PROFILE_NAME,
            role: 'reviewer',
            model: '',
            skills: [],
            instructions: DEFAULT_REVIEWER_INSTRUCTIONS
          };
        reviewDiff = worktreeDiff({ workspacePath: workspace, baseBranch: task.baseBranch });
      } else {
```

> Add imports to `index.ts`: `REVIEWER_PROFILE_NAME, DEFAULT_REVIEWER_INSTRUCTIONS` from `../shared/types`, and `worktreeDiff` from `./kanban/workspace` (match the existing workspace import group).

- [ ] **Step 4: Flip the orchestrator roster filter (S8) and pass the new fields to `spawnRuneWorker`**

In the `else` (orchestrator) branch, change the roster filter:

```ts
        roster = profiles
          .filter((p) => p.role === 'worker')
          .map((p) => ({ /* …unchanged… */ }));
```

In the `spawnRuneWorker({ task: {…}, … })` input object, add `reviewDiff` and `reviewFindings` alongside `verifyFailure`:

```ts
          verifyFailure,
          reviewDiff,
          reviewFindings,
```

- [ ] **Step 5: Wire `autoReview` into `buildDispatcherConfig`**

Find `buildDispatcherConfig` in `index.ts` (the object returned around line 860). After `autoIntegrate: d.autoIntegrate,` add:

```ts
      autoReview: d.autoReview,
```

(`d` is `settingsStore.get().kanban.dispatcher`, which now carries `autoReview` from Task 1.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(kanban): wire review spawn + roster filter + autoReview config (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `kanban_review_verdict` terminal tool + review_ready emit

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts` (tool def, `REVIEW_TOOLS`, `toolsForMode`, handler, mode-aware author, `review_ready`)
- Test: `src/main/__tests__/kanban-review-mcp.test.ts` (new)

> Read how the verify gate / `kanban_assign` are wired in `kanban-mcp-server.ts` first (`handleToolCall` at ~966, `kanban_complete` at ~998, `toolsForMode` at ~470).

- [ ] **Step 1: Write failing tests**

Create `src/main/__tests__/kanban-review-mcp.test.ts`. Mirror the existing `kanban-mcp-verify.test.ts` harness (it constructs a `KanbanMcpServer`, registers a run token, and invokes `handleToolCall` over a fake `ServerResponse`). Reuse that file's helpers; the assertions:

```ts
// (harness copied from kanban-mcp-verify.test.ts: makeServer(store), call(server, token, name, args))
describe('kanban_review_verdict', () => {
  it('approve records verdict + head sha + reviewer comment + review_passed event', async () => {
    const { store, server } = makeServer();
    const t = store.createTask({ title: 'x', status: 'running', workspaceKind: 'worktree', assignee: 'w' });
    store.setWorkspace(t.id, REPO, 'b', 'main'); // REPO is a git repo fixture with a HEAD
    const run = store.startRun(t.id, 'reviewer', 1, 'review');
    store.setWorkerPid(t.id, run.id, 1);
    const token = register(server, { kind: 'task', taskId: t.id, runId: run.id, mode: 'review' });
    await call(server, token, 'kanban_review_verdict', { decision: 'approve', summary: 'lgtm' });
    const got = store.getTask(t.id)!;
    expect(got.reviewVerdict).toBe('approve');
    expect(got.reviewHeadSha).toMatch(/^[0-9a-f]{7,}/);
    expect(got.status).toBe('running'); // does NOT clear current_run_id; reclaim routes next tick
    expect(got.currentRunId).toBe(run.id);
    expect(store.getComments(t.id).some((c) => c.author === 'reviewer')).toBe(true);
    expect(store.listEvents(t.id).some((e) => e.kind === 'review_passed')).toBe(true);
  });

  it('request_changes records findings + review_changes_requested event', async () => {
    const { store, server } = makeServer();
    const t = store.createTask({ title: 'x', status: 'running', workspaceKind: 'worktree', assignee: 'w' });
    store.setWorkspace(t.id, REPO, 'b', 'main');
    const run = store.startRun(t.id, 'reviewer', 1, 'review');
    const token = register(server, { kind: 'task', taskId: t.id, runId: run.id, mode: 'review' });
    await call(server, token, 'kanban_review_verdict', {
      decision: 'request_changes', summary: 'fix it', findings: [{ file: 'a.ts', note: 'null check' }]
    });
    expect(store.getTask(t.id)!.reviewVerdict).toBe('request_changes');
    const ev = store.listEvents(t.id).find((e) => e.kind === 'review_changes_requested');
    expect(ev).toBeTruthy();
  });

  it('rejects an invalid decision and an empty summary', async () => {
    const { store, server } = makeServer();
    const t = store.createTask({ title: 'x', status: 'running', workspaceKind: 'worktree' });
    const run = store.startRun(t.id, 'reviewer', 1, 'review');
    const token = register(server, { kind: 'task', taskId: t.id, runId: run.id, mode: 'review' });
    const r1 = await call(server, token, 'kanban_review_verdict', { decision: 'nope', summary: 'x' });
    expect(r1.error ?? r1.isError).toBeTruthy();
    const r2 = await call(server, token, 'kanban_review_verdict', { decision: 'approve', summary: '' });
    expect(r2.error ?? r2.isError).toBeTruthy();
  });

  it('CAS guard: a verdict for a non-current run is a no-op', async () => {
    const { store, server } = makeServer();
    const t = store.createTask({ title: 'x', status: 'running', workspaceKind: 'worktree' });
    const stale = store.startRun(t.id, 'reviewer', 1, 'review');
    const current = store.startRun(t.id, 'reviewer', 2, 'review'); // current_run_id now = current.id
    const token = register(server, { kind: 'task', taskId: t.id, runId: stale.id, mode: 'review' });
    await call(server, token, 'kanban_review_verdict', { decision: 'approve', summary: 'x' });
    expect(store.getTask(t.id)!.reviewVerdict).toBeNull();
  });
});
```

> If `kanban-mcp-verify.test.ts` doesn't export reusable helpers, copy its `makeServer`/`register`/`call` setup into this file. `REPO` is a git-initialized temp dir (see the workspace test fixture in Task 2 for the setup snippet). `register` must set `current_run_id` — use `store.startRun` (which does) and the scope's `runId`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-review-mcp.test.ts`
Expected: FAIL — `unknown tool: kanban_review_verdict`.

- [ ] **Step 3: Add the tool definition + `REVIEW_TOOLS` + `toolsForMode` case**

In `src/main/kanban/kanban-mcp-server.ts`, after `SUGGEST_TOOLS` add:

```ts
const REVIEW_TOOLS: McpTool[] = [
  ...WORKER_TOOLS.filter((t) =>
    ['kanban_show', 'kanban_comment', 'kanban_heartbeat'].includes(t.name)
  ),
  {
    name: 'kanban_review_verdict',
    description:
      'Record the code-review verdict for this task. Terminal — ends the review run. ' +
      "decision is 'approve' or 'request_changes'; include specific findings on request_changes.",
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approve', 'request_changes'] },
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: { file: { type: 'string' }, note: { type: 'string' } },
            required: ['note']
          }
        }
      },
      required: ['decision', 'summary']
    }
  }
];
```

In `toolsForMode`, add before the final `return WORKER_TOOLS;`:

```ts
  if (mode === 'review') return REVIEW_TOOLS;
```

- [ ] **Step 4: Make the comment author mode-aware (S7)**

In `handleToolCall`, change (line ~976):

```ts
    const author = scope.mode === 'review' ? 'reviewer' : (task.assignee ?? 'worker');
```

- [ ] **Step 5: Implement the handler case**

Add a `case 'kanban_review_verdict':` in the tool `switch` (alongside the other task tools). Import `headSha` from `./workspace` (add to the existing workspace import). Implementation:

```ts
        case 'kanban_review_verdict': {
          const a = z
            .object({
              decision: z.enum(['approve', 'request_changes']),
              summary: z.string().min(1),
              findings: z
                .array(z.object({ file: z.string().optional(), note: z.string().min(1) }))
                .optional()
            })
            .parse(args);
          // CAS guard: only the current review run on a still-running task may record.
          if (scope.runId !== task.currentRunId || task.status !== 'running') {
            this.unregisterRun(token);
            return this.text(res, rpcReq.id, `Verdict ignored: task ${task.id} moved on.`);
          }
          const sha =
            a.decision === 'approve' && task.workspacePath ? headSha(task.workspacePath) : null;
          this.store.setReviewVerdict(task.id, a.decision, sha);
          const findingsText = (a.findings ?? [])
            .map((f) => `- ${f.file ? `${f.file}: ` : ''}${f.note}`)
            .join('\n');
          this.store.addComment(
            task.id,
            'reviewer',
            `review ${a.decision}: ${a.summary}${findingsText ? `\n${findingsText}` : ''}`
          );
          this.store.appendEvent(
            task.id,
            scope.runId,
            a.decision === 'approve' ? 'review_passed' : 'review_changes_requested',
            { summary: a.summary, findings: a.findings ?? [] }
          );
          this.store.finishRun(scope.runId, 'completed', { summary: a.summary });
          this.unregisterRun(token);
          return this.text(res, rpcReq.id, `Verdict recorded for task ${task.id}.`);
        }
```

> **Invariant:** this handler must NOT call `reviewTask`/`setStatusCleared`/`completeTask`/`blockTask`/`returnToReady` — the task stays `running` with `current_run_id` intact so `reclaim()` (Task 7) routes it. `finishRun` does not clear `current_run_id` (verified). Confirm `this.store.getComments` and `this.store.appendEvent` names match the store (they're used elsewhere in this file).

- [ ] **Step 6: Change the ungated worktree completion event to `review_ready` (B2)**

In `kanban_complete`, the **ungated** worktree path emits `'completed'` (line ~1087). Change ONLY that one event kind to `'review_ready'`:

```ts
            this.store.appendEvent(task.id, scope.runId, 'review_ready', { summary: a.summary });
```

> Do NOT change the scratch/dir/decompose completion event at line ~1097 — that stays `'completed'`. Do NOT change the `finishRun(..., 'completed', …)` outcome — that's a run outcome, not an event kind.

- [ ] **Step 7: Run the MCP tests + the existing verify MCP tests (regression)**

Run: `npx vitest run src/main/__tests__/kanban-review-mcp.test.ts src/main/__tests__/kanban-mcp-verify.test.ts`
Expected: PASS. If a verify test asserted a `'completed'` event on an ungated worktree completion, update it to `'review_ready'`.

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add -A && git commit -m "feat(kanban): kanban_review_verdict tool + review_ready event (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `reviewTasks()` dispatcher stage

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`reviewTasks()`, constant, tick wiring)
- Test: `src/main/__tests__/kanban-dispatcher-review.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `src/main/__tests__/kanban-dispatcher-review.test.ts` (mirror `kanban-dispatcher-verify.test.ts`'s `baseConfig`/harness; add `autoReview: true` to `baseConfig`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanDispatcher, type SpawnWorkerArgs } from '../kanban/kanban-dispatcher';

const db = () => join(tmpdir(), `fleet-disp-rev-${Math.random()}.db`);
function baseConfig() {
  return {
    failureLimit: 3, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 100000,
    autoDecompose: false, autoAssign: false, autoIntegrate: false, autoReview: true,
    maxDecompose: 1, artifactRetentionDays: 0
  };
}
function reviewable(store: KanbanStore) {
  const t = store.createTask({ title: 'x', status: 'review', workspaceKind: 'worktree' });
  store.setWorkspace(t.id, join(tmpdir(), 'wt'), 'b', 'main');
  return store.getTask(t.id)!;
}

describe('reviewTasks()', () => {
  it('claims a review-pending worktree task and spawns a review run', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = reviewable(store);
    const spawn = vi.fn<(a: SpawnWorkerArgs) => number | undefined>(() => 42);
    const disp = new KanbanDispatcher(store, {
      now: () => 1000, isAlive: () => true, spawnWorker: spawn, config: baseConfig()
    });
    disp.reviewTasks();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].mode).toBe('review');
    expect(store.getTask(t.id)!.status).toBe('running');
    store.close();
  });

  it('autoReview off -> no-op', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    reviewable(store);
    const spawn = vi.fn(() => 42);
    const disp = new KanbanDispatcher(store, {
      now: () => 1000, isAlive: () => true, spawnWorker: spawn,
      config: { ...baseConfig(), autoReview: false }
    });
    disp.reviewTasks();
    expect(spawn).not.toHaveBeenCalled();
    store.close();
  });

  it('skips swarm members', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = reviewable(store);
    vi.spyOn(store, 'isSwarmMember').mockReturnValue(true);
    const spawn = vi.fn(() => 42);
    const disp = new KanbanDispatcher(store, {
      now: () => 1000, isAlive: () => true, spawnWorker: spawn, config: baseConfig()
    });
    disp.reviewTasks();
    expect(spawn).not.toHaveBeenCalled();
    expect(store.getTask(t.id)!.status).toBe('review');
    store.close();
  });

  it('spawn failure under failureLimit -> back to review', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = reviewable(store);
    const spawn = vi.fn(() => { throw new Error('boom'); });
    const disp = new KanbanDispatcher(store, {
      now: () => 1000, isAlive: () => true, spawnWorker: spawn, config: baseConfig()
    });
    disp.reviewTasks();
    expect(store.getTask(t.id)!.status).toBe('review');
    expect(store.listEvents(t.id).some((e) => e.kind === 'spawn_failed')).toBe(true);
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher-review.test.ts`
Expected: FAIL — `disp.reviewTasks is not a function`.

- [ ] **Step 3: Add the constant + `reviewTasks()` method**

In `src/main/kanban/kanban-dispatcher.ts`, near `MAX_INTEGRATE_PER_TICK`:

```ts
/** Max review runs spawned per tick. */
const MAX_REVIEW_PER_TICK = 3;
/** Review-fix work runs attempted per task before soft-escalation. Tracked in tasks.review_attempts. */
const REVIEW_ATTEMPT_CAP = 2;
```

Add the method (near `integrate()`):

```ts
  /** Spawn an agent review run for each review-pending worktree task (gated on autoReview). */
  reviewTasks(): void {
    if (!this.deps.config.autoReview) return;
    let budget = MAX_REVIEW_PER_TICK;
    const ttl = this.deps.config.claimTtlMs;
    for (const task of this.store.reviewPendingTasks()) {
      if (budget <= 0) break;
      if (this.store.isSwarmMember(task.id)) continue; // swarms carry their own verifier card
      const lock = this.nextLock();
      if (!this.store.claimForReview(task.id, lock, ttl)) continue; // lost race
      let runId: number | null = null;
      try {
        const workspace = this.deps.prepareWorkspaceFn
          ? this.deps.prepareWorkspaceFn(task)
          : (task.workspacePath ?? '');
        const run = this.store.startRun(task.id, 'reviewer', null, 'review');
        runId = run.id;
        const pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode: 'review' });
        if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
        this.store.appendEvent(task.id, run.id, 'spawned', { pid: pid ?? null, mode: 'review' });
        budget -= 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.recordFailure(task.id, msg);
        if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
        this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg, mode: 'review' });
        const failures = this.store.getTask(task.id)?.consecutiveFailures ?? 0;
        if (failures >= this.deps.config.failureLimit) {
          // Persistent spawn failure: stop bouncing forever — soft-escalate to a human.
          this.store.setStatusCleared(task.id, 'review');
          this.store.appendEvent(task.id, null, 'review_escalated', {
            reason: `review could not be spawned after ${failures} attempt(s)`
          });
        } else {
          this.store.setStatusCleared(task.id, 'review'); // retry next tick
        }
        log.error('review spawn failed', { taskId: task.id, error: msg });
      }
    }
  }
```

- [ ] **Step 4: Wire it into `tick()` before `integrate()`**

In `tick()` (line ~1004), insert between `claimAndSpawn()` and `integrate()`:

```ts
    this.claimAndSpawn();
    this.reviewTasks();
    this.integrate();
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher-review.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add -A && git commit -m "feat(kanban): reviewTasks() dispatcher stage (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `reclaim()` review branch + `spawnReviewFix` + clear-on-fresh-work

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (reclaim branch, `spawnReviewFix`, `clearReviewVerdict` calls in claimAndSpawn / spawnResolve)
- Test: `src/main/__tests__/kanban-dispatcher-review.test.ts` (extend)

> Read the existing `reclaim()` verify branch (lines ~182-226) — the review branch sits right after it and mirrors its shape.

- [ ] **Step 1: Write failing reclaim tests**

Append to `src/main/__tests__/kanban-dispatcher-review.test.ts`:

```ts
import { type WorkerExit } from '../kanban/kanban-dispatcher';

// A task parked 'running' with a finished review run, as kanban_review_verdict leaves it.
function reviewing(store: KanbanStore, verdict: 'approve' | 'request_changes' | null) {
  const t = store.createTask({ title: 'x', status: 'running', workspaceKind: 'worktree' });
  store.setWorkspace(t.id, join(tmpdir(), 'wt'), 'b', 'main');
  const run = store.startRun(t.id, 'reviewer', 7, 'review');
  store.setWorkerPid(t.id, run.id, 7);
  if (verdict) store.setReviewVerdict(t.id, verdict, verdict === 'approve' ? 'sha1' : null);
  return { task: store.getTask(t.id)!, runId: run.id };
}

describe('reclaim() review branch', () => {
  it('approve -> review, verdict + head sha kept, attempts reset', () => {
    // review_passed is emitted by the verdict TOOL (Task 5), not by reclaim — so this
    // unit (which sets the verdict directly via reviewing()) does not assert that event.
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task, runId } = reviewing(store, 'approve');
    store.incrementReviewAttempts(task.id);
    const exits = new Map<number, WorkerExit>([[runId, { code: 0, signal: null }]]);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000, isAlive: () => true, spawnWorker: () => undefined, config: baseConfig(),
      workerExit: (id) => exits.get(id), clearWorkerExit: () => undefined
    });
    disp.reclaim();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(after.reviewVerdict).toBe('approve');
    expect(after.reviewHeadSha).toBe('sha1');
    expect(after.reviewAttempts).toBe(0);
    store.close();
  });

  it('request_changes under cap -> spawns a work fix run with reviewFindings + clears verdict', () => {
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task, runId } = reviewing(store, 'request_changes');
    store.appendEvent(task.id, runId, 'review_changes_requested', {
      summary: 's', findings: [{ file: 'a.ts', note: 'null check' }]
    });
    const exits = new Map<number, WorkerExit>([[runId, { code: 0, signal: null }]]);
    const spawn = vi.fn<(a: SpawnWorkerArgs) => number | undefined>(() => 99);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000, isAlive: () => true, spawnWorker: spawn, config: baseConfig(),
      workerExit: (id) => exits.get(id), clearWorkerExit: () => undefined
    });
    disp.reclaim();
    expect(spawn).toHaveBeenCalledTimes(1);
    const arg = spawn.mock.calls[0][0];
    expect(arg.mode).toBe('work');
    expect(arg.reviewFindings).toContain('null check');
    const after = store.getTask(task.id)!;
    expect(after.reviewAttempts).toBe(1);
    expect(after.reviewVerdict).toBeNull();
    expect(after.status).toBe('running');
    store.close();
  });

  it('request_changes at cap -> soft-escalate to review with review_escalated', () => {
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task, runId } = reviewing(store, 'request_changes');
    store.incrementReviewAttempts(task.id);
    store.incrementReviewAttempts(task.id); // == REVIEW_ATTEMPT_CAP
    const exits = new Map<number, WorkerExit>([[runId, { code: 0, signal: null }]]);
    const spawn = vi.fn(() => 99);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000, isAlive: () => true, spawnWorker: spawn, config: baseConfig(),
      workerExit: (id) => exits.get(id), clearWorkerExit: () => undefined
    });
    disp.reclaim();
    expect(spawn).not.toHaveBeenCalled();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(after.reviewVerdict).toBe('request_changes'); // kept so integrate skips it
    expect(store.listEvents(task.id).some((e) => e.kind === 'review_escalated')).toBe(true);
    store.close();
  });

  it('inconclusive (no verdict) -> soft-escalate', () => {
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task, runId } = reviewing(store, null);
    const exits = new Map<number, WorkerExit>([[runId, { code: 3, signal: null }]]);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000, isAlive: () => false, spawnWorker: () => undefined, config: baseConfig(),
      workerExit: (id) => exits.get(id), clearWorkerExit: () => undefined
    });
    disp.reclaim();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(store.listEvents(task.id).some((e) => e.kind === 'review_escalated')).toBe(true);
    store.close();
  });

  it('exit==null but reviewer pid alive (long review) -> stays running, claim re-extended', () => {
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task } = reviewing(store, null);
    store.claimForVerifyFix(task.id, 'L', 100000);
    store.extendClaim(task.id, 'L', -1); // force-expire, lock retained
    const spawn = vi.fn(() => 99);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000, isAlive: () => true, spawnWorker: spawn, config: baseConfig(),
      workerExit: () => undefined, clearWorkerExit: () => undefined
    });
    disp.reclaim();
    expect(store.getTask(task.id)!.status).toBe('running');
    expect(spawn).not.toHaveBeenCalled();
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher-review.test.ts`
Expected: FAIL — approve test sees `status === 'running'` (no review branch yet).

- [ ] **Step 3: Add the reclaim review branch**

In `reclaim()`, immediately AFTER the `if (reclaimMode === 'verify') { … }` block (around line 226) and BEFORE the `if (exit?.code === REVIEW_REQUIRED_EXIT_CODE)` block, add:

```ts
      if (reclaimMode === 'review') {
        const runId = task.currentRunId;
        // Long review that outlived its claim but is still running: keep waiting.
        if (exit == null && task.workerPid != null && this.deps.isAlive(task.workerPid)) {
          if (task.claimLock) this.store.extendClaim(task.id, task.claimLock, VERIFY_CLAIM_TTL_MS);
          continue;
        }
        const verdict = task.reviewVerdict;
        if (verdict === 'approve') {
          // The verdict tool already finished the run + emitted review_passed. The verdict
          // and head_sha persist through setStatusCleared (it clears only claim/run fields).
          this.store.setStatusCleared(task.id, 'review');
          this.store.resetReviewAttempts(task.id);
        } else if (verdict === 'request_changes' && task.reviewAttempts < REVIEW_ATTEMPT_CAP) {
          this.spawnReviewFix(task, this.lastReviewFindings(task.id));
        } else {
          // At cap (verdict recorded by the tool), or inconclusive (no verdict — the agent ended
          // without calling the tool, so the run was never finished). Soft-escalate to human review.
          if (verdict == null && runId != null) this.store.finishRun(runId, 'reclaimed');
          this.store.setStatusCleared(task.id, 'review'); // verdict (if any) persists → integrate skips it
          const reason =
            verdict === 'request_changes'
              ? `review requested changes after ${REVIEW_ATTEMPT_CAP} attempt(s)`
              : 'reviewer returned no verdict';
          this.store.appendEvent(task.id, runId, 'review_escalated', { reason });
          this.store.addComment(task.id, 'dispatcher', reason);
        }
        if (runId != null) this.deps.clearWorkerExit?.(runId);
        continue;
      }
```

> **Event ownership:** the verdict tool (Task 5) is the sole emitter of `review_passed` / `review_changes_requested` and the sole finisher of the review run on a recorded verdict. The reclaim branch only routes: it emits `review_escalated` and finishes the run ONLY in the inconclusive (no-verdict) case. This avoids a duplicate `review_passed` event and a double `finishRun`. `setStatusCleared` does NOT touch `review_verdict`/`review_head_sha`/`review_attempts` (verified — it nulls only claim/run fields), so no re-assert is needed; the verdict persists.

- [ ] **Step 4: Add `spawnReviewFix` + `lastReviewFindings` helpers**

Add near `spawnVerifyFix`:

```ts
  /** The findings from the most recent request_changes event, formatted for the bounce prompt. */
  private lastReviewFindings(taskId: string): string {
    const ev = [...this.store.listEvents(taskId)]
      .reverse()
      .find((e) => e.kind === 'review_changes_requested');
    const payload = ev?.payload as { summary?: string; findings?: Array<{ file?: string; note: string }> } | undefined;
    const lines = (payload?.findings ?? []).map((f) => `- ${f.file ? `${f.file}: ` : ''}${f.note}`);
    return [payload?.summary, ...lines].filter(Boolean).join('\n');
  }

  /** Spawn a fresh `work` run to address review findings (mirrors spawnVerifyFix). */
  private spawnReviewFix(task: Task, findings: string): boolean {
    const lock = this.nextLock();
    if (!this.store.claimForVerifyFix(task.id, lock, this.deps.config.claimTtlMs)) return false;
    this.store.clearReviewVerdict(task.id); // diff will change → drop the prior verdict
    this.store.incrementReviewAttempts(task.id);
    let runId: number | null = null;
    try {
      const workspace = task.workspacePath ?? '';
      const run = this.store.startRun(task.id, task.assignee ?? 'worker', null, 'work');
      runId = run.id;
      const pid = this.deps.spawnWorker({
        task, runId: run.id, lock, workspace, mode: 'work', reviewFindings: findings
      });
      if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
      this.store.appendEvent(task.id, run.id, 'spawned', {
        pid: pid ?? null, mode: 'work', reason: 'review-fix', attempt: task.reviewAttempts + 1
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.recordFailure(task.id, msg);
      if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
      this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg, mode: 'work' });
      this.store.setStatusCleared(task.id, 'ready');
      log.error('review-fix spawn failed', { taskId: task.id, error: msg });
      return false;
    }
  }
```

> `lastReviewFindings` reads `payload` as a typed shape via a local annotation (no `as` cast on a value — it's a type assertion on the unknown payload; if the repo's eslint bans this, parse with a small `z.object(...).safeParse(ev?.payload)` instead and read `.data`). Prefer the zod path to stay within the no-unsafe-cast rule:

```ts
    const parsed = z
      .object({
        summary: z.string().optional(),
        findings: z.array(z.object({ file: z.string().optional(), note: z.string() })).optional()
      })
      .safeParse(ev?.payload);
    const p = parsed.success ? parsed.data : {};
```

Add `import { z } from 'zod';` to the dispatcher if not present.

- [ ] **Step 5: Clear the verdict on fresh non-review work + on resolve**

In `claimAndSpawn()` (the `work` spawn loop), right after a successful `claimTask`, before `startRun`, add:

```ts
      this.store.clearReviewVerdict(task.id);
      this.store.resetReviewAttempts(task.id); // a fresh human-initiated work cycle starts a new review episode
```

In `spawnResolve()` (after a successful `claimForResolve`, before `startRun`), add:

```ts
      this.store.clearReviewVerdict(task.id); // a resolve changes the tree → re-review the result
```

> Rationale: a `ready`→`work` claim or a `resolve` run mutates the diff, invalidating any prior verdict (S2/S3). `clearReviewVerdict` is a no-op when the verdict is already null, so this is safe on every claim.

- [ ] **Step 6: Run the full review dispatcher suite + verify suite (regression)**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher-review.test.ts src/main/__tests__/kanban-dispatcher-verify.test.ts src/main/__tests__/kanban-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add -A && git commit -m "feat(kanban): reclaim review branch + spawnReviewFix + clear-on-rework (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `integrate()` approve-guard + HEAD-SHA assertion

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`integrateTasks` guard)
- Test: `src/main/__tests__/kanban-dispatcher-review.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

Append to `src/main/__tests__/kanban-dispatcher-review.test.ts`. The integrate path needs a feature task + injected `integration` ops. Mirror the existing `kanban-dispatcher.test.ts` integrate harness (it stubs `IntegrationOps`); the new assertions:

```ts
describe('integrate() review guard', () => {
  function featureReviewTask(store: KanbanStore, verdict: 'approve' | 'request_changes' | null, sha: string | null) {
    const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/repo', baseBranch: 'main' });
    const t = store.createTask({ title: 'x', status: 'review', workspaceKind: 'worktree', featureId: f.id, repoPath: '/repo', branchName: 'feat', baseBranch: 'main' });
    store.setWorkspace(t.id, '/repo/wt', 'feat', 'main');
    store.updateFeature(f.id, { integrationBranch: 'fleet/feature-' + f.id });
    if (verdict) store.setReviewVerdict(t.id, verdict, sha);
    return store.getTask(t.id)!;
  }
  const ops = (over = {}) => ({
    ensureFeatureBranch: () => ({ ok: true }),
    checkMergeConflicts: () => ({ state: 'clean', files: [] }),
    mergeWorktreeToBase: vi.fn(() => ({ ok: true })),
    updateIntegrationBranchFromMain: () => ({ ok: true }),
    removeWorktree: () => undefined, isBranchMerged: () => true,
    createFeaturePr: () => ({ ok: true }), pushIntegrationBranch: () => ({ ok: true }),
    markPrReady: () => ({ ok: true }), headSha: () => 'sha1', ...over
  });

  it('autoReview on + verdict != approve -> NOT merged', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = featureReviewTask(store, 'request_changes', null);
    const merge = vi.fn(() => ({ ok: true }));
    const disp = new KanbanDispatcher(store, {
      now: () => 1000, isAlive: () => true, spawnWorker: () => undefined,
      config: { ...baseConfig(), autoIntegrate: true }, integration: ops({ mergeWorktreeToBase: merge })
    });
    disp.integrate();
    expect(merge).not.toHaveBeenCalled();
    store.close();
  });

  it('approve + matching HEAD -> merged', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    featureReviewTask(store, 'approve', 'sha1');
    const merge = vi.fn(() => ({ ok: true }));
    const disp = new KanbanDispatcher(store, {
      now: () => 1000, isAlive: () => true, spawnWorker: () => undefined,
      config: { ...baseConfig(), autoIntegrate: true }, integration: ops({ mergeWorktreeToBase: merge })
    });
    disp.integrate();
    expect(merge).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('approve but HEAD drifted -> verdict cleared, NOT merged', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = featureReviewTask(store, 'approve', 'OLDsha');
    const merge = vi.fn(() => ({ ok: true }));
    const disp = new KanbanDispatcher(store, {
      now: () => 1000, isAlive: () => true, spawnWorker: () => undefined,
      config: { ...baseConfig(), autoIntegrate: true }, integration: ops({ headSha: () => 'NEWsha', mergeWorktreeToBase: merge })
    });
    disp.integrate();
    expect(merge).not.toHaveBeenCalled();
    expect(store.getTask(t.id)!.reviewVerdict).toBeNull();
    store.close();
  });
});
```

> Confirm `createFeature`/`updateFeature` signatures against the store; adjust if the test helpers differ. If `autoReview` defaults true in `baseConfig`, these run with the guard active.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher-review.test.ts -t "review guard"`
Expected: FAIL — the request_changes task gets merged (no guard yet).

- [ ] **Step 3: Add the guard in `integrateTasks`**

In `integrateTasks()`, at the top of the `for` loop, after the existing `if (!task.repoPath || …) continue;` line (line ~712), add:

```ts
      // Agent review gate (#232): a reviewed task merges only on an 'approve' verdict,
      // and only at the exact HEAD that was approved (a later run may have changed the tree).
      if (this.deps.config.autoReview) {
        if (task.reviewVerdict !== 'approve') continue;
        const head = this.ops.headSha(task.workspacePath);
        if (head != null && task.reviewHeadSha != null && head !== task.reviewHeadSha) {
          this.store.clearReviewVerdict(task.id); // drifted → re-review next tick
          this.store.appendEvent(task.id, null, 'review_stale', { approved: task.reviewHeadSha, head });
          continue;
        }
      }
```

- [ ] **Step 4: Run the tests (review guard + full integrate regression)**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher-review.test.ts src/main/__tests__/kanban-dispatcher.test.ts`
Expected: PASS. (Existing integrate tests run with `autoReview` — if `baseConfig` in the OLD `kanban-dispatcher.test.ts` lacks `autoReview`, those tests get `autoReview: undefined` → falsy → guard inert → unchanged. Good. But if a test sets a feature review task expecting a merge and now `autoReview` is true via a shared config, set `autoReview: false` on that test's config or give the task an `approve` verdict.)

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add -A && git commit -m "feat(kanban): integrate() approve-guard + stale-diff assertion (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Notifications — classify + dual-channel gate-pass suppression

**Files:**
- Modify: `src/shared/kanban-notifications.ts` (classify `review_*`)
- Modify: `src/main/kanban/kanban-notifier.ts` (suppress gate-pass set when autoReview on — OS)
- Modify: `src/renderer/src/hooks/useKanbanAttention.ts` (suppress gate-pass set when autoReview on — badge)
- Test: `src/shared/__tests__/kanban-notifications.test.ts` (extend)

> Read `kanban-notifier.ts` and `useKanbanAttention.ts` before editing — both call `classifyKanbanEvent`/`kanbanNotifyChannel` and both have the kanban settings in scope. The suppression set is `{ review_ready, verify_passed, verify_skipped }`.

- [ ] **Step 1: Write failing classify tests**

Append to `src/shared/__tests__/kanban-notifications.test.ts` (inside the `classifyKanbanEvent` describe):

```ts
  it('maps review verdict events to completed, in-flight ones to null', () => {
    expect(classifyKanbanEvent('review_ready')).toBe('completed');
    expect(classifyKanbanEvent('review_passed')).toBe('completed');
    expect(classifyKanbanEvent('review_escalated')).toBe('completed');
    expect(classifyKanbanEvent('review_changes_requested')).toBeNull();
    expect(classifyKanbanEvent('review_started')).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/shared/__tests__/kanban-notifications.test.ts`
Expected: FAIL — `review_ready` returns null.

- [ ] **Step 3: Extend `classifyKanbanEvent`**

In `src/shared/kanban-notifications.ts`, add the new `completed`-category kinds to the existing `case` group:

```ts
    case 'completed':
    case 'review_ready':
    case 'review_passed':
    case 'review_escalated':
    case 'verify_passed':
    case 'verify_skipped':
    case 'feature_pr_ready':
      return 'completed';
```

(`review_changes_requested` and `review_started` need no case — they fall through to `default → null`.)

- [ ] **Step 4: Run the classify test**

Run: `npx vitest run src/shared/__tests__/kanban-notifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Suppress the gate-pass set when autoReview is on (OS channel)**

In `src/main/kanban/kanban-notifier.ts`, find where an event is turned into an OS notification (it calls `classifyKanbanEvent` or `kanbanNotifyChannel`). Add a guard: when `autoReview` is enabled, drop events in the gate-pass set (the verdict event will fire the real notification). Add near the top of the file:

```ts
/** Gate-pass events whose review-ready notification is deferred to the agent verdict when autoReview is on. */
const REVIEW_GATE_PASS_KINDS = new Set(['review_ready', 'verify_passed', 'verify_skipped']);
```

At the start of the per-event handling (before the `classifyKanbanEvent`/channel check), add (using the notifier's existing access to settings — read `settingsStore.get().kanban.dispatcher.autoReview`; match however this file already reads settings):

```ts
    if (autoReview && REVIEW_GATE_PASS_KINDS.has(event.kind)) return; // deferred to the review verdict
```

> If `kanban-notifier.ts` does not already import the settings store, thread `autoReview` in the same way it gets other config (read the file; it is constructed in `index.ts` and likely already receives settings or a getter). Do NOT hardcode `true`.

- [ ] **Step 6: Suppress the gate-pass set in the badge hook (renderer)**

In `src/renderer/src/hooks/useKanbanAttention.ts`, the hook calls `kanbanNotifyChannel(event.kind, …, 'badge')`. Add the same guard, reading `autoReview` from the kanban settings the renderer already has (the hook consumes kanban settings/events — match its existing source). Add:

```ts
const REVIEW_GATE_PASS_KINDS = new Set(['review_ready', 'verify_passed', 'verify_skipped']);
```

and in the per-event filter:

```ts
  if (autoReview && REVIEW_GATE_PASS_KINDS.has(event.kind)) return false; // deferred to the review verdict
```

> Match the hook's return convention (it returns a boolean "should attend"). When autoReview is OFF, no `review_*` events exist and these gate-pass events notify exactly as today.

- [ ] **Step 7: Typecheck (node + web)**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(kanban): review notifications + deferred gate-pass alerts (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: UI — review badge + Settings reviewer editor

**Files:**
- Modify: the kanban card/drawer badge component (find via the resolve/verify badge — grep `verify` / `'resolving'` in `src/renderer/src/components/kanban/`)
- Modify: the Settings kanban section (find via `ORCHESTRATOR_PROFILE_NAME` usage in `src/renderer/.../KanbanSection.tsx`)
- Test: manual (UI), plus typecheck

> This task is UI-only; there is no unit test harness for these components. Verify by typecheck and a build. Read how the orchestrator profile editor and the resolve/verify run badges are implemented before mirroring.

- [ ] **Step 1: Add the review run/verdict badge**

In the card/drawer badge component that renders run-mode badges (the one showing "resolving conflicts — attempt n/2" and the verify state), add cases for the review run and verdict:
- run mode `review` in flight → "reviewing…" (optionally "reviewing — attempt n/2" using `task.reviewAttempts`).
- `task.reviewVerdict === 'request_changes'` → "changes requested".
- `task.reviewVerdict === 'approve'` → "approved".

Drive these off the same task fields + streamed `review_*` events the resolve/verify badges already use. Match the existing badge styling (Tailwind classes already in the file).

- [ ] **Step 2: Add the reviewer profile editor to Settings**

In the kanban Settings section, where the singleton orchestrator profile is edited (persona textarea + model + "Reset to default"), add a parallel block for the reviewer:
- Resolve the reviewer profile by `REVIEWER_PROFILE_NAME`; if absent, show the `DEFAULT_REVIEWER_INSTRUCTIONS` as the placeholder/initial value (create-on-save, exactly as the orchestrator block does).
- "Reset to default" writes `DEFAULT_REVIEWER_INSTRUCTIONS`.
- The saved profile has `role: 'reviewer'`, `name: 'reviewer'`.
- Add an `autoReview` toggle next to the existing `autoIntegrate`/`autoAssign` toggles, bound to `kanban.dispatcher.autoReview`.

> Import `REVIEWER_PROFILE_NAME`, `DEFAULT_REVIEWER_INSTRUCTIONS` from `@shared/types` (match the existing orchestrator imports in this file).

- [ ] **Step 3: Typecheck both projects**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Build (catches renderer wiring)**

Run: `npm run build`
Expected: PASS (typecheck + electron-vite build).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(kanban): review badge + reviewer profile settings + autoReview toggle (#232)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] **Full suite:** `npx vitest run` — all green.
- [ ] **Typecheck:** `npm run typecheck` — clean.
- [ ] **Lint:** `npm run lint` — no NEW errors (repo lint is pre-existing-red; compare against baseline). Confirm no `as` casts or `eslint-disable` were introduced in `src` production code.
- [ ] **Build:** `npm run build` — succeeds.
- [ ] Dispatch a final whole-implementation review subagent (spec-compliance over the full diff vs `docs/superpowers/specs/2026-06-12-kanban-agent-review-design.md`), then use `superpowers:finishing-a-development-branch`.

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| §Architecture / tick placement | 6 |
| §1 reviewTasks() (incl. spawn-failure bound) | 6 |
| §2 review run mode (tools, prompt, diff) | 3, 4 |
| §3 kanban_review_verdict (CAS guard, record-only, no status clear) | 5 |
| §4 reviewer singleton + missing-profile fallback | 3, 4 |
| §4.1 index.ts spawn wiring (no assignee clobber, roster flip, author) | 4, 5 |
| §5 reclaim review branch (alive-wait, approve/bounce/escalate, lifecycle) | 7 |
| §6 integrate approve-guard + HEAD-SHA assertion | 8 |
| §7 notifications (review_ready, dual-channel suppression) | 9 |
| §8 settings & guardrails (autoReview, cap, fail-open) | 1, 4, 6, 7, 10 |
| §9 data model (migration 15, store methods, isSwarmMember, role) | 1, 2 |
| §10 UI | 10 |
| §11 testing | every task (TDD) |
