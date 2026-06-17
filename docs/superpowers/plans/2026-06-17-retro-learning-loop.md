# Retro/Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a feature ships (its PR merges), fire a PM "retro" turn that distills durable learnings into the Learnings KB + MEMORY.md and surfaces a short retro summary with suggested profile/prompt improvements.

**Architecture:** A new `retro` PM turn origin, fired by the existing #233 autopilot. The PR poller transitions a merged feature to `status='shipped'` (fire-once) and emits a `feature_shipped` event; the autopilot routes that event to a dedicated retro turn (separate from the coalesced triage briefing). The board-scoped PM rune agent reads the feature's artifacts, auto-writes learnings (new `kanban_learning_create` tool, board scope) + MEMORY.md notes, and surfaces suggestions. A small fix in the PM turn queue keeps a queued retro from being superseded by later event/digest turns.

**Tech Stack:** TypeScript, Electron main process, better-sqlite3, zod, vitest. Spec: `docs/superpowers/specs/2026-06-17-retro-learning-loop-design.md`.

**Conventions for every task:**
- Tests live in `src/main/__tests__/` (or `src/main/kanban/__tests__/` for pm-* files) and run with `npx vitest run <path>`.
- NO unsafe type assertions in `src/` — no `as` casts, no `eslint-disable`. Use zod for runtime parsing. (Casts are allowed only in `*.test.ts` and the established `as Array<Record<string, unknown>>` DB-row idiom in `kanban-store.ts`.)
- Repo lint is pre-existing-red; only fix lint you introduce.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Match surrounding code style; surgical changes only.

---

### Task 1: Add the `retro` PM turn origin

**Files:**
- Modify: `src/shared/kanban-types.ts:15`

This is a type-only enabling change consumed by Tasks 4, 5, and 7. There is no behavior to unit-test; verification is the typecheck.

- [ ] **Step 1: Add `'retro'` to the `PmTurnOrigin` union**

In `src/shared/kanban-types.ts`, change:

```ts
/** What drove a PM chat turn: a human message, a board event, or a periodic digest. */
export type PmTurnOrigin = 'user' | 'event' | 'digest';
```

to:

```ts
/** What drove a PM chat turn: a human message, a board event, a periodic digest, or a post-ship retro. */
export type PmTurnOrigin = 'user' | 'event' | 'digest' | 'retro';
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (no errors). `PmTurnOrigin` is referenced in `pm-chat-service.ts`, `pm-autopilot.ts`, and `index.ts`; adding a union member is backward compatible.

- [ ] **Step 3: Commit**

```bash
git add src/shared/kanban-types.ts
git commit -m "$(cat <<'EOF'
feat(kanban): add 'retro' PM turn origin (#235)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: PR-poller fires `feature_shipped` on merge

**Files:**
- Modify: `src/main/kanban/pr-poller.ts:102-113` (inside `sweepFeatures`)
- Test: `src/main/__tests__/kanban-pr-poller.test.ts`

When a polled feature's PR state becomes `merged`, transition the feature to `status='shipped'` once and emit a `feature_shipped` event. The `status === 'active'` guard (plus `featuresDuePrSync`'s `pr_state IN ('open','draft')` filter, which excludes a merged PR from the next sweep) makes this fire exactly once.

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('PrPoller feature sweep', ...)` block in `src/main/__tests__/kanban-pr-poller.test.ts` (after the last `it(...)`, before the closing `});`):

```ts
  it('flips a merged feature to shipped and emits feature_shipped exactly once', () => {
    const clock = 400_000;
    const store = new KanbanStore(join(TEST_DIR, `feat-shipped-${Math.random()}.db`), {
      now: () => clock
    });
    const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/repo' });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'open');
    const fetchPrState = (): PrFetchResult => ({
      ok: true,
      state: 'merged',
      checksState: 'passing',
      mergeState: 'CLEAN',
      url: 'https://x/pull/9',
      number: 9
    });
    const poller = new PrPoller(store, { now: () => clock, fetchPrState });
    poller.sweep();

    const got = store.getFeature(f.id)!;
    expect(got.status).toBe('shipped');
    const shipped = store.listEvents(f.id).filter((e) => e.kind === 'feature_shipped');
    expect(shipped).toHaveLength(1);
    expect(shipped[0].payload).toEqual({ prNumber: 9 });

    // A shipped feature is no longer open/draft, so featuresDuePrSync excludes it:
    // a second sweep must not re-ship or re-emit.
    poller.sweep();
    expect(store.listEvents(f.id).filter((e) => e.kind === 'feature_shipped')).toHaveLength(1);
    store.close();
  });

  it('does not ship a feature whose PR is merely open', () => {
    const clock = 500_000;
    const store = new KanbanStore(join(TEST_DIR, `feat-open-${Math.random()}.db`), {
      now: () => clock
    });
    const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/repo' });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
    const fetchPrState = (): PrFetchResult => ({
      ok: true,
      state: 'open',
      checksState: 'passing',
      mergeState: 'CLEAN',
      url: 'https://x/pull/9',
      number: 9
    });
    const poller = new PrPoller(store, { now: () => clock, fetchPrState });
    poller.sweep();

    expect(store.getFeature(f.id)!.status).toBe('active');
    expect(store.listEvents(f.id).filter((e) => e.kind === 'feature_shipped')).toHaveLength(0);
    store.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-pr-poller.test.ts`
Expected: FAIL — the "merged → shipped" test fails (status stays `'active'`, no `feature_shipped` event). The "merely open" test passes already (no-op path).

- [ ] **Step 3: Add the shipped transition in `sweepFeatures`**

In `src/main/kanban/pr-poller.ts`, locate the end of the `for (const feature of due)` loop body in `sweepFeatures` — the block that writes PR status and emits `feature_pr_synced` (around lines 102-113):

```ts
      const changed = feature.prState !== res.state || feature.checksState !== res.checksState;
      this.store.setFeaturePrStatus(feature.id, {
        prState: res.state,
        checksState: res.checksState
      });
      if (changed) {
        this.store.appendEvent(feature.id, null, 'feature_pr_synced', {
          state: res.state,
          checks: res.checksState
        });
      }
```

Immediately after that `if (changed) { ... }` block (still inside the `for` loop), add:

```ts
      // A merged PR is the terminal "shipped" signal (#235): flip status once and emit
      // feature_shipped so the PM autopilot can run a retro. The status guard — plus
      // featuresDuePrSync's open/draft-only filter, which drops a merged PR from the
      // next sweep — makes this fire exactly once.
      if (res.state === 'merged' && feature.status === 'active') {
        this.store.updateFeature(feature.id, { status: 'shipped' });
        this.store.appendEvent(feature.id, null, 'feature_shipped', {
          prNumber: feature.prNumber ?? null
        });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-pr-poller.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/pr-poller.ts src/main/__tests__/kanban-pr-poller.test.ts
git commit -m "$(cat <<'EOF'
feat(kanban): fire feature_shipped when a feature PR merges (#235)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Retro briefing builder

**Files:**
- Create: `src/main/kanban/pm-retro.ts`
- Test: `src/main/__tests__/pm-retro.test.ts`

A pure function that turns a shipped feature + its tasks + per-task runs/events into the retro turn prompt. No store dependency — callers pass accessors (so it is trivially testable and the wiring lives in `index.ts`, Task 7).

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/pm-retro.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRetroBriefing } from '../kanban/pm-retro';
import type { Feature, Task, TaskRun, TaskEvent } from '../../shared/kanban-types';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f1',
    boardId: 'b1',
    name: 'Dark mode',
    status: 'shipped',
    repoPath: '/repo',
    baseBranch: 'main',
    integrationBranch: 'feat/dark-mode',
    mergeState: 'merged',
    prUrl: 'https://x/pull/9',
    prNumber: 9,
    prState: 'merged',
    checksState: 'passing',
    syncedAt: 0,
    prSkipNotified: false,
    qaVerdict: 'pass',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Add toggle',
    body: '',
    assignee: 'alice',
    status: 'done',
    priority: 1,
    tenant: null,
    workspaceKind: 'worktree',
    workspacePath: '/repo',
    branchName: 'kanban/t1',
    baseBranch: 'main',
    modelOverride: null,
    skills: [],
    docs: [],
    boardId: 'b1',
    featureId: 'f1',
    idempotencyKey: null,
    result: null,
    pendingMode: null,
    claimLock: null,
    claimExpires: null,
    workerPid: null,
    currentRunId: null,
    lastHeartbeatAt: null,
    consecutiveFailures: 0,
    resolveAttempts: 0,
    verifyAttempts: 0,
    reviewVerdict: null,
    reviewAttempts: 0,
    reviewHeadSha: null,
    lastFailureError: null,
    maxRuntimeSeconds: null,
    maxRetries: 0,
    scheduleKind: null,
    scheduleCron: null,
    scheduleIntervalMs: null,
    nextRunAt: null,
    schedulePaused: false,
    scheduledFrom: null,
    prInfo: null,
    conflictState: null,
    conflictFiles: [],
    worktreePruned: false,
    systemKind: null,
    pipelineTemplate: null,
    pipelineStage: null,
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 1,
    taskId: 't1',
    profile: 'alice',
    status: 'finished',
    mode: 'work',
    workerPid: null,
    startedAt: 0,
    endedAt: 1,
    outcome: 'completed',
    summary: 'implemented the toggle',
    metadata: null,
    error: null,
    ...overrides
  };
}

function event(kind: string, taskId = 't1'): TaskEvent {
  return { id: 1, taskId, runId: null, kind, payload: null, createdAt: 0 };
}

describe('buildRetroBriefing', () => {
  it('names the shipped feature and its QA verdict', () => {
    const out = buildRetroBriefing(feature(), [task()], () => [run()], () => []);
    expect(out).toContain('Dark mode');
    expect(out).toContain('qa: pass');
  });

  it('surfaces friction: failing review verdicts and verify retries', () => {
    const flaky = task({
      id: 't2',
      title: 'Persist preference',
      reviewVerdict: 'request_changes',
      reviewAttempts: 2,
      verifyAttempts: 2
    });
    const out = buildRetroBriefing(
      feature(),
      [flaky],
      () => [run({ taskId: 't2', outcome: 'completed', summary: 'eventually green' })],
      (id) => (id === 't2' ? [event('verify_failed', 't2'), event('review_changes_requested', 't2')] : [])
    );
    expect(out).toContain('Persist preference');
    expect(out).toContain('request_changes');
    expect(out).toContain('verify_failed');
  });

  it('instructs the PM to search prior memory, write learnings, and suggest improvements', () => {
    const out = buildRetroBriefing(feature(), [task()], () => [run()], () => []);
    expect(out).toMatch(/learnings_search/);
    expect(out).toMatch(/kanban_learning_create/);
    expect(out).toMatch(/MEMORY\.md/);
    expect(out).toMatch(/suggest/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/pm-retro.test.ts`
Expected: FAIL — `Cannot find module '../kanban/pm-retro'`.

- [ ] **Step 3: Implement `pm-retro.ts`**

Create `src/main/kanban/pm-retro.ts`:

```ts
import type { Feature, Task, TaskRun, TaskEvent } from '../../shared/kanban-types';

/** Event kinds that signal friction worth a retro mention. */
const FRICTION_EVENTS = new Set(['blocked', 'verify_failed', 'gave_up', 'review_changes_requested']);

/**
 * Build the prompt for a post-ship retro PM turn (#235). Pure: callers inject the
 * run/event accessors so this stays trivially testable and store-free.
 */
export function buildRetroBriefing(
  feature: Feature,
  tasks: Task[],
  runsFor: (taskId: string) => TaskRun[],
  eventsFor: (taskId: string) => TaskEvent[]
): string {
  const taskLines: string[] = [];
  for (const t of tasks) {
    const runs = runsFor(t.id);
    const lastSummary = [...runs].reverse().find((r) => r.summary)?.summary ?? '(no summary)';
    const friction = eventsFor(t.id)
      .map((e) => e.kind)
      .filter((k) => FRICTION_EVENTS.has(k));
    const parts = [
      `- ${t.title} (${t.id}): ${t.status}`,
      t.reviewVerdict ? `review=${t.reviewVerdict} (attempts=${t.reviewAttempts})` : null,
      t.verifyAttempts > 0 ? `verify_attempts=${t.verifyAttempts}` : null,
      friction.length ? `friction=[${friction.join(', ')}]` : null
    ].filter(Boolean);
    taskLines.push(parts.join('  '));
    taskLines.push(`    summary: ${lastSummary}`);
  }

  return [
    `A feature just shipped: "${feature.name}" (${feature.id}).`,
    `qa: ${feature.qaVerdict ?? 'n/a'}    pr: ${feature.prUrl ?? 'none'}`,
    '',
    'Member tasks and how they went:',
    ...(taskLines.length ? taskLines : ['(no member tasks recorded)']),
    '',
    'Run a retrospective:',
    '1. Before writing anything, call learnings_search and re-read MEMORY.md for',
    '   entries related to what you see above — recognize anything recurring.',
    '2. Capture durable TECHNICAL learnings (a gotcha, a discovered constraint, a',
    `   pattern that worked) with kanban_learning_create — pass feature_id="${feature.id}".`,
    '3. Append concise BOARD-PROCESS notes (recurring blockers, profile/prompt',
    '   friction) to MEMORY.md. When something recurs, escalate the note',
    '   ("this has now bitten N features") rather than duplicating it.',
    '4. Reply with a short retro summary: what went well, what kept failing, and any',
    '   SUGGESTED profile/prompt/doc improvements. Suggestions only — do not apply',
    '   profile or prompt changes yourself.'
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/pm-retro.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/pm-retro.ts src/main/__tests__/pm-retro.test.ts
git commit -m "$(cat <<'EOF'
feat(kanban): add retro briefing builder (#235)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Autopilot recognizes `feature_shipped` and fires a retro turn

**Files:**
- Modify: `src/main/kanban/pm-autopilot.ts` (add `RETRO_KIND`, `buildRetro` dep, retro branch in `onEvent`)
- Test: `src/main/kanban/__tests__/pm-autopilot.test.ts`

`feature_shipped` must NOT flow through the coalesced triage briefing (whose prompt tells the PM to "unblock stuck work"). Handle it on a separate path that builds the retro prompt and runs a `'retro'` turn immediately (no coalescing — a retro is rare and feature-specific).

- [ ] **Step 1: Write the failing tests**

In `src/main/kanban/__tests__/pm-autopilot.test.ts`, update the `makeDeps` helper to include the new optional dep, then add tests. First, extend `makeDeps` (add `buildRetro` to the `deps` object literal, after `log: () => {}`):

```ts
    log: () => {},
    buildRetro: (featureId: string) => `retro for ${featureId}`
```

Then add this block after the existing `describe('PmAutopilot event turns', ...)` block:

```ts
describe('PmAutopilot retro turns', () => {
  it('fires a retro turn for feature_shipped without coalescing', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps();
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('feature_shipped', 'f1'));
    // No coalesce wait needed — retro dispatches immediately.
    expect(runTurn).toHaveBeenCalledWith('b1', 'retro for f1', 'retro');
    vi.useRealTimers();
  });

  it('does not fire a retro when autopilot is disabled', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps({
      getConfig: () => ({ autopilotEnabled: false, eventMinGapMs: 30_000, coalesceWindowMs: 2_000 })
    });
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('feature_shipped', 'f1'));
    expect(runTurn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('skips the retro when buildRetro returns null', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps({ buildRetro: () => null });
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('feature_shipped', 'f1'));
    expect(runTurn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not bucket feature_shipped into the triage briefing', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps();
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('feature_shipped', 'f1'));
    vi.advanceTimersByTime(2_000);
    // Exactly one call, and it is the retro — feature_shipped never reaches buildBriefing.
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith('b1', 'retro for f1', 'retro');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/kanban/__tests__/pm-autopilot.test.ts`
Expected: FAIL — `feature_shipped` is not in `TRIGGER_KINDS` so nothing fires; the retro tests fail because the branch doesn't exist. (TypeScript may also flag `buildRetro` as an unknown dep property — that resolves in Step 3.)

- [ ] **Step 3: Add the retro path to `pm-autopilot.ts`**

In `src/main/kanban/pm-autopilot.ts`:

(a) Add the constant just below `TRIGGER_KINDS` (after line 12):

```ts
/** The feature-level event that triggers a post-ship retro turn (#235). */
const RETRO_KIND = 'feature_shipped';
```

(b) Add the `buildRetro` dep to `PmAutopilotDeps` (after the `buildBriefing` field, around line 28):

```ts
  /**
   * Build the retro-turn prompt for a shipped feature, or null if it can't be
   * resolved (then the retro is skipped). Wired in index.ts where the store is in
   * scope, mirroring buildBriefing/buildDigest.
   */
  buildRetro?: (featureId: string) => string | null;
```

(c) In `onEvent`, add the retro branch BEFORE the `TRIGGER_KINDS` check. Replace:

```ts
  onEvent(event: TaskEvent): void {
    try {
      if (!this.deps.getConfig().autopilotEnabled) return;
      if (!TRIGGER_KINDS.has(event.kind)) return;
      const boardId = this.deps.getBoardForTask(event.taskId);
      if (!boardId) return;
      this.buffer(boardId, event);
    } catch (err) {
```

with:

```ts
  onEvent(event: TaskEvent): void {
    try {
      if (!this.deps.getConfig().autopilotEnabled) return;
      if (event.kind === RETRO_KIND) {
        this.fireRetro(event);
        return;
      }
      if (!TRIGGER_KINDS.has(event.kind)) return;
      const boardId = this.deps.getBoardForTask(event.taskId);
      if (!boardId) return;
      this.buffer(boardId, event);
    } catch (err) {
```

(d) Add the `fireRetro` private method (place it just above the existing `private batch(...)` method). `event.taskId` carries the feature id (feature-level events append with the feature id as the task id):

```ts
  /**
   * Dispatch a one-off retro turn for a shipped feature. Unlike triage events,
   * a retro is not coalesced — it is feature-specific and rare. Skipped silently
   * when the prompt builder is unwired or can't resolve the feature.
   */
  private fireRetro(event: TaskEvent): void {
    const boardId = this.deps.getBoardForTask(event.taskId);
    if (!boardId || !this.deps.buildRetro) return;
    const prompt = this.deps.buildRetro(event.taskId);
    if (!prompt) return;
    void this.deps.runTurn(boardId, prompt, 'retro').catch((err) => {
      this.deps.log('pm-autopilot retro turn failed', {
        boardId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/kanban/__tests__/pm-autopilot.test.ts`
Expected: PASS (existing event/digest tests plus the four new retro tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/pm-autopilot.ts src/main/kanban/__tests__/pm-autopilot.test.ts
git commit -m "$(cat <<'EOF'
feat(kanban): fire a retro PM turn on feature_shipped (#235)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Keep queued retro turns from being superseded

**Files:**
- Modify: `src/main/kanban/pm-chat-service.ts:206-213` (the supersede block in `enqueueTurn`)
- Test: `src/main/kanban/__tests__/pm-chat-service.test.ts`

Today a new non-user turn drops all queued non-user turns. A queued retro must survive a later `event`/`digest` turn, or a shipped feature can silently lose its retro. Preserve `user` AND `retro` turns; drop only `event`/`digest`.

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe('PmChatService turn queue', ...)` block in `src/main/kanban/__tests__/pm-chat-service.test.ts` (after the last `it(...)`, before the closing `});`):

```ts
  it('a later event turn does not supersede a queued retro turn', async () => {
    const children: Array<ReturnType<typeof fakeChild>> = [];
    spawnMock.mockImplementation(() => {
      const c = fakeChild();
      children.push(c);
      return c;
    });
    const svc = makeService({});

    // A user turn is in flight...
    void svc.runTurn('b1', 'user', 'user');
    await Promise.resolve();
    expect(children).toHaveLength(1);

    // ...a retro queues behind it, then an event turn arrives.
    const retro = svc.runTurn('b1', 'retro-1', 'retro');
    void svc.runTurn('b1', 'event-1', 'event');
    await Promise.resolve();
    expect(children).toHaveLength(1); // still only the user turn spawned

    children[0].emit('exit', 0, null); // finish the user turn
    // The retro must have survived: it spawns next.
    await vi.waitFor(() => expect(children).toHaveLength(2));

    children[1].emit('exit', 0, null);
    await retro; // the retro turn ran to completion (was never dropped)
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/kanban/__tests__/pm-chat-service.test.ts`
Expected: FAIL — the event turn supersedes the queued retro, so `retro` resolves as superseded and the spawned child for it never appears (the `waitFor` times out, or the wrong prompt runs).

- [ ] **Step 3: Preserve retro turns in the supersede filter**

In `src/main/kanban/pm-chat-service.ts`, find the supersede block in `enqueueTurn` (around lines 206-213):

```ts
    // A new event/digest turn supersedes any still-queued non-user turns: only the
    // latest event context matters. Resolve the dropped ones cleanly (they were
    // intentionally superseded, not failed). User turns are never dropped.
    if (origin !== 'user') {
      const stale = c.queue.filter((q) => q.origin !== 'user');
      c.queue = c.queue.filter((q) => q.origin === 'user');
      for (const s of stale) s.resolve();
    }
```

Replace it with:

```ts
    // A new event/digest turn supersedes any still-queued event/digest turns: only
    // the latest event context matters. user and retro turns are durable — a human
    // message must never be dropped, and a per-feature retro must survive event churn
    // so every shipped feature gets its entry (#235). Resolve dropped turns cleanly
    // (intentionally superseded, not failed).
    if (origin !== 'user') {
      const durable = (o: PmTurnOrigin): boolean => o === 'user' || o === 'retro';
      const stale = c.queue.filter((q) => !durable(q.origin));
      c.queue = c.queue.filter((q) => durable(q.origin));
      for (const s of stale) s.resolve();
    }
```

(`PmTurnOrigin` is already imported in this file — it types `QueuedTurn.origin` and `runTurn`'s parameter.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/kanban/__tests__/pm-chat-service.test.ts`
Expected: PASS — including the existing "a new event turn supersedes an already-queued event turn" test (event-vs-event supersession is unchanged) and the new retro-survival test.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/pm-chat-service.ts src/main/kanban/__tests__/pm-chat-service.test.ts
git commit -m "$(cat <<'EOF'
fix(kanban): never supersede a queued retro turn (#235)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `kanban_learning_create` MCP tool (PM board scope)

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts` (import type, `learningsStore` field + `setLearningsStore`, `PM_TOOLS` entry, handler case)
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

A board-scoped tool that writes a learning to the KB. Marked with a `'retro'` tag for provenance (`CreateLearningInput.sourceAgent` is `'rune' | 'claude'` only, so we do NOT set it). Best-effort dedup via `sourceSessionId = feature_id`. Registered only for board scope; worker tool sets are untouched.

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-mcp-server.test.ts`, add the import at the top (after the existing imports):

```ts
import { LearningsStore } from '../learnings/learnings-store';
```

Then add a new `describe` block at the end of the file (the PM-scope suite uses a board run token `'pmtok'` and `server.setCommands(commands)` in its `beforeEach`; this block sets up its own minimal server so it is self-contained):

```ts
describe('KanbanMcpServer kanban_learning_create', () => {
  let store: KanbanStore;
  let learnings: LearningsStore;
  let server: KanbanMcpServer;
  let base: string;
  const dir = join(TEST_DIR, `learn-${Date.now()}`);

  beforeEach(async () => {
    mkdirSync(dir, { recursive: true });
    store = new KanbanStore(join(dir, 'mcp.db'));
    learnings = new LearningsStore(join(dir, 'learnings.db'));
    const dispatcher = new KanbanDispatcher(store, { now: () => 1 });
    const commands = new KanbanCommands(store, dispatcher, () => ({
      workspaceKind: 'scratch',
      maxRuntimeSeconds: null
    }));
    server = new KanbanMcpServer(store);
    server.setCommands(commands);
    server.setLearningsStore(learnings);
    server.registerRun('pmtok', { kind: 'board', boardId: 'default' });
    const port = await server.start(0);
    base = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    learnings.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists kanban_learning_create for a board token', async () => {
    const r = await rpc(`${base}?run=pmtok`, 'tools/list');
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('kanban_learning_create');
  });

  it('writes a learning tagged retro', async () => {
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_learning_create',
      arguments: {
        title: 'better-sqlite3 WAL needs busy_timeout',
        body: 'Set busy_timeout to avoid SQLITE_BUSY under concurrent writes.',
        tags: ['sqlite'],
        feature_id: 'f1'
      }
    });
    expect(String(r.result.content[0].text)).toMatch(/Learning saved/);
    const all = learnings.search({});
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('better-sqlite3 WAL needs busy_timeout');
    expect(all[0].tags).toContain('retro');
    expect(all[0].tags).toContain('sqlite');
    expect(all[0].sourceSessionId).toBe('f1');
  });

  it('rejects kanban_learning_create from a worker token', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100000);
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('wtok', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'L');
    const r = await rpc(`${base}?run=wtok`, 'tools/call', {
      name: 'kanban_learning_create',
      arguments: { title: 'nope', body: 'nope' }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/unknown tool/i);
  });
});
```

(`LearningsStore.search({})` returns all rows newest-first; `Learning` has `tags: string[]` and `sourceSessionId: string | null`; `close()` exists — all verified against `src/main/learnings/learnings-store.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: FAIL — `server.setLearningsStore` is not a function / `kanban_learning_create` is unknown.

- [ ] **Step 3: Add the import and the injector**

In `src/main/kanban/kanban-mcp-server.ts`:

(a) Add the type import near the other `import type` lines at the top of the file:

```ts
import type { LearningsStore } from '../learnings/learnings-store';
```

(b) Add the field next to the other injected deps (near `private kanbanHome: string | null = null;`, around line 631):

```ts
  private learningsStore: LearningsStore | null = null;
```

(c) Add the injector next to `setKanbanHome` (around line 657):

```ts
  /** Inject the learnings KB so the PM's retro turn can persist durable learnings. */
  setLearningsStore(store: LearningsStore): void {
    this.learningsStore = store;
  }
```

- [ ] **Step 4: Add the `PM_TOOLS` descriptor**

In the `PM_TOOLS` array in `src/main/kanban/kanban-mcp-server.ts`, add this entry as the last element (after the `kanban_propose` entry, before the closing `];` at line 546):

```ts
  ,
  {
    name: 'kanban_learning_create',
    description:
      'Save a durable, reusable learning to the cross-project knowledge base (semantically ' +
      'searchable by future workers). Use during a retro to capture a technical gotcha, a ' +
      'discovered constraint, or a pattern that worked. Pass feature_id (the shipped feature) ' +
      'so a re-run does not duplicate. Board-process notes belong in MEMORY.md, not here.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        feature_id: { type: 'string' }
      },
      required: ['title', 'body']
    }
  }
```

- [ ] **Step 5: Add the handler case**

In `handlePmToolCall`'s `switch (name)` (the async board-tool switch starting around line 836), add this case alongside the others (e.g. after the `kanban_create` case):

```ts
        case 'kanban_learning_create': {
          const ls = this.learningsStore;
          if (!ls) return this.rpcError(res, rpcReq.id, 'learnings store is not available');
          const a = z
            .object({
              title: z.string().min(1),
              body: z.string().min(1),
              tags: z.array(z.string()).optional(),
              project: z.string().optional(),
              feature_id: z.string().optional()
            })
            .parse(args);
          const defaultProject = this.store
            .listProjects(scope.boardId)
            .find((p) => p.isDefault)?.name;
          const learning = ls.create({
            title: a.title,
            body: a.body,
            tags: ['retro', ...(a.tags ?? [])],
            sourceProject: a.project ?? defaultProject,
            sourceSessionId: a.feature_id
          });
          return this.text(res, rpcReq.id, `Learning saved: ${learning.id}`);
        }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: PASS (all, including the three new ones).

- [ ] **Step 7: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "$(cat <<'EOF'
feat(kanban): add kanban_learning_create board-scope MCP tool (#235)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire the retro into the live app

**Files:**
- Modify: `src/main/index.ts` (import `buildRetroBriefing`; add `buildRetro` to the `PmAutopilot` deps; call `kanbanMcp.setLearningsStore`)

This connects the pieces that unit tests stub. `index.ts` is not unit-tested; verification is typecheck + build + the full suite.

- [ ] **Step 1: Import the retro briefing builder**

In `src/main/index.ts`, add to the imports near the other `./kanban/*` imports (e.g. next to `import { PmAutopilot, buildEventBriefing } from './kanban/pm-autopilot';` at line 56):

```ts
import { buildRetroBriefing } from './kanban/pm-retro';
```

- [ ] **Step 2: Add the `buildRetro` dep to the `PmAutopilot` constructor**

In the `pmAutopilot = new PmAutopilot({ ... })` object (around lines 1235-1268), add a `buildRetro` property (place it right after the `buildBriefing: (events) => ...` block, before `log:`):

```ts
    buildRetro: (featureId) => {
      const store = kanbanStore;
      if (!store) return null;
      const feature = store.getFeature(featureId);
      if (!feature) return null;
      const tasks = store.listFeatureTasks(featureId);
      return buildRetroBriefing(
        feature,
        tasks,
        (id) => store.listRuns(id),
        (id) => store.listEvents(id)
      );
    },
```

- [ ] **Step 3: Inject the learnings store into the kanban MCP server**

In `src/main/index.ts`, find where `learningsStoreRef` is constructed (line 1294):

```ts
  const learningsStoreRef = new LearningsStore(join(learningsHome, 'learnings.db'));
```

Immediately after that line, add:

```ts
  kanbanMcp?.setLearningsStore(learningsStoreRef);
```

(`kanbanMcp` is the module-scoped server created earlier at line 916; the injector is safe to call late — the tool reads `this.learningsStore` at call time.)

- [ ] **Step 4: Verify typecheck, full suite, and build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx vitest run`
Expected: PASS (entire suite, including every test added in Tasks 2-6).

Run: `npm run build`
Expected: PASS (typecheck + electron-vite build succeed).

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "$(cat <<'EOF'
feat(kanban): wire post-ship retro turn + learnings store (#235)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- New `retro` PM turn origin → Task 1, Task 4.
- Trigger: PR merge → `status='shipped'` + `feature_shipped` (fire-once) → Task 2.
- Autopilot recognition on a separate (non-triage) path, gated by `autopilotEnabled` → Task 4.
- Retro briefing: artifacts + the four PM instructions (search recurrence, write KB learnings, append MEMORY.md, suggest improvements) → Task 3.
- Learnings KB write tool, board scope only, `'retro'` tag (no `sourceAgent`), best-effort `feature_id` dedup → Task 6.
- Supersession fix so retros are never dropped → Task 5.
- Auto-write learnings + MEMORY.md; profile/prompt changes as suggestions only → enforced by the Task 3 prompt text (the agent writes MEMORY.md/learnings, only suggests profile changes).
- Live wiring → Task 7.
- Out-of-scope items (cross-feature analytics, auto-applying profile changes, no-PR ship trigger, manual re-run) → intentionally not in any task.

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. All store accessors used (`search`, `close`, `listProjects().find(p => p.isDefault)`, `listFeatureTasks`, `listRuns`, `listEvents`, `getFeature`, `updateFeature`, `appendEvent`) are verified to exist with the signatures used.

**Type consistency:** `buildRetroBriefing(feature, tasks, runsFor, eventsFor)` signature is identical in Task 3 (definition), Task 4 test stub (behavioral), and Task 7 (call site). `PmTurnOrigin` value `'retro'` is consistent across Tasks 1/4/5. `buildRetro?: (featureId: string) => string | null` matches between the dep definition (Task 4), the test stub (Task 4), and the call site (Task 7). `setLearningsStore` / `learningsStore` naming consistent between Task 6 and Task 7. `kanban_learning_create` arg shape (`title, body, tags?, project?, feature_id?`) consistent between the descriptor and the handler.
