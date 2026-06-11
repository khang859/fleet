# Draft → Ready Feature PR Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the kanban autopilot publish a feature as a single draft PR the moment its first task merges into the integration branch, keep that PR fresh on subsequent merges, and flip it to "ready for review" once every member task is done and the branch is cleanly synced with main.

**Architecture:** This extends issue #228's `integrate()` dispatcher stage (the LOCAL-GIT-ONLY phase). #228 deferred all origin-push/`gh` work to #229 — this is that issue, so origin push + `gh pr create --draft` + `gh pr ready` now come in-scope. All new git operations are injected through the existing `IntegrationOps` seam (`kanban-dispatcher.ts`) so the dispatcher stays unit-testable with mocked git ops, exactly like #228. Two new dispatcher methods hook the existing merge/sync points: `ensureFeaturePr()` (called after each task merge in `integrateTasks`) and `markFeaturePrReady()` (called at the all-done sync points in `integrateFeatures`). A feature-level `pr_skip_notified` flag de-dupes the "no remote / no gh" event so it fires at most once per feature. The existing `PrPoller` is extended to also refresh feature-PR state. The manual **Ship** button becomes a true override that flips an existing draft to ready.

**Tech Stack:** Electron main process, TypeScript, better-sqlite3 (kanban store + additive schema migration), `gh` CLI + `git` via `execFileSync`, Vitest (mocked store deps / workspace fns), React (renderer badge).

---

## Background: exact code being extended

Read these before starting — every task references them.

- **`integrate()` stage** — `src/main/kanban/kanban-dispatcher.ts:452-606`.
  - `integrateTasks()` (459-529): the **clean-merge success block is lines 499-518** (`if (res.ok) { completeTask … resetResolveAttempts … }`). The draft-PR hook attaches at the **end** of this block (after line 517).
  - `integrateFeatures()` (531-606): the two **"feature is done + integration synced with main"** points are (a) the post-resolve synced branch — after `updateFeature(feature.id, { mergeState: 'in_progress' })` at **line 580**, and (b) the clean-sync branch — after the same call at **line 597**. The pr-ready hook attaches at both.
- **`IntegrationOps` seam** — interface `kanban-dispatcher.ts:44-51`, defaults `53-60`, getter `this.ops` `122-124`. Tests inject via `DispatcherDeps.integration` (`94-110`).
- **Feature git ops** — `src/main/kanban/workspace.ts`: `createFeaturePr()` (697-713), `ghPrCreate()` (503-539), `fetchPrState()` (768-821, already detects `isDraft → 'draft'`), `updateIntegrationBranchFromMain()` (640-690).
- **Feature store** — `src/main/kanban/kanban-store.ts`: `setFeaturePr()` (1380-1386, **hardcodes `pr_state='open'`**), `updateFeature()` (1354-1377), `rowToFeature()` (1295-1311), `getFeature()` (1327), `listFeatures()` (1331-1352), `tasksDuePrSync()` (959), `setPrStatus()` (898-921), migration block (`if (current < 11)` at 178-182). `SCHEMA_VERSION = 11` in `src/main/kanban/schema.ts:1`; features table DDL at `schema.ts:117-131` and the idempotent v9 copy at `kanban-store.ts:141-155`.
- **Feature type** — `src/shared/kanban-types.ts:38` (`PrState = 'open'|'merged'|'closed'|'draft'`), `40` (`ChecksState`), `57-76` (`Feature`, `UpdateFeatureInput`).
- **PrPoller** — `src/main/kanban/pr-poller.ts` (full file). Currently sweeps **tasks only** via `tasksDuePrSync`. Constructed in `src/main/index.ts:1075`.
- **Manual Ship** — `src/main/kanban/kanban-commands.ts:1028-1058` (`shipFeature`). Only other `setFeaturePr` caller is line 1051.
- **UI** — `src/renderer/src/components/kanban/FeaturePrRollup.tsx` (full file). Uses `feature.prState` / `feature.prUrl`.
- **Notifier** — `src/shared/kanban-notifications.ts` (`classifyKanbanEvent`), `src/main/kanban/kanban-notifier.ts:59-72` (`enqueue` — drops events whose `getTask(event.taskId)` is null; feature events use `taskId = featureId`).
- **Test style** — `src/main/__tests__/kanban-dispatcher.test.ts`: `baseConfig` (390-400), `fakeIntegration()` builder (402-412), `makeStore`, `reviewFeatureTask` helper (970+). Also `kanban-store.test.ts`, `kanban-commands.test.ts`, `kanban-notifier.test.ts`.

**Verification commands (run from repo root):**
- Single test file: `npx vitest run src/main/__tests__/<file>.test.ts`
- Type check: `npm run typecheck`
- Lint: `npm run lint`

**Convention reminders:** no `as` casts / no `eslint-disable` in `src` (use zod or proper typing; the kanban-store file-local query-cast convention is the only exception). Commits end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Vitest does not typecheck — run `npm run typecheck` separately.

---

## Task 1: Schema v12 — feature PR-lifecycle columns

Adds the three feature columns this plan needs: `checks_state` (feature-PR CI state, polled), `pr_synced_at` (poller cadence), `pr_skip_notified` (de-dupe the no-remote skip event). `pr_state`/`pr_url`/`pr_number` already exist. **Do not** store the GH `mergeStateStatus` on features — `Feature.mergeState` already means the *integration-sync* state (`pending|in_progress|conflict|merged`); reusing the name would collide.

**Files:**
- Modify: `src/main/kanban/schema.ts:1` (version) and `:117-131` (features DDL)
- Modify: `src/main/kanban/kanban-store.ts:141-155` (idempotent v9 copy) and add a `if (current < 12)` migration block after line 182
- Modify: `src/shared/kanban-types.ts:57-76` (`Feature` interface)
- Modify: `src/main/kanban/kanban-store.ts:1295-1311` (`rowToFeature`)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing test** — append to `src/main/__tests__/kanban-store.test.ts`:

```ts
it('v12: features carry checksState / syncedAt / prSkipNotified, default null/0', () => {
  const store = makeStore(); // existing helper in this file
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  const got = store.getFeature(f.id)!;
  expect(got.checksState).toBeNull();
  expect(got.syncedAt).toBeNull();
  expect(got.prSkipNotified).toBe(false);
  store.close();
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run src/main/__tests__/kanban-store.test.ts` → FAIL (`checksState`/`syncedAt`/`prSkipNotified` undefined or type error).

- [ ] **Step 3: Bump the schema version** — `src/main/kanban/schema.ts:1`:

```ts
export const SCHEMA_VERSION = 12;
```

- [ ] **Step 4: Add columns to both features DDLs** — in `src/main/kanban/schema.ts` features table (after `pr_state TEXT,` near line 128) and in the idempotent copy at `src/main/kanban/kanban-store.ts` (after `pr_state TEXT,` near line 152), add the same three lines:

```sql
        checks_state TEXT,
        pr_synced_at INTEGER,
        pr_skip_notified INTEGER NOT NULL DEFAULT 0,
```

- [ ] **Step 5: Add the migration block** — in `src/main/kanban/kanban-store.ts`, immediately after the `if (current < 11) { … }` block (ends line 182):

```ts
    if (current < 12) {
      // Phase-3 autopilot (draft PR lifecycle): feature-level PR freshness + a
      // fire-once flag for the "no remote/gh, PR skipped" event.
      this.addColumnIfMissing('features', 'checks_state', 'TEXT');
      this.addColumnIfMissing('features', 'pr_synced_at', 'INTEGER');
      this.addColumnIfMissing('features', 'pr_skip_notified', 'INTEGER NOT NULL DEFAULT 0');
    }
```

- [ ] **Step 6: Extend the `Feature` type** — `src/shared/kanban-types.ts`, add to the `Feature` interface (after `prState: PrState | null;`):

```ts
  checksState: ChecksState | null;
  syncedAt: number | null;
  prSkipNotified: boolean;
```

- [ ] **Step 7: Map the new columns** — `src/main/kanban/kanban-store.ts` `rowToFeature` (after `prState: …` line 1307):

```ts
      checksState: (r.checks_state as ChecksState | null) ?? null,
      syncedAt: (r.pr_synced_at as number | null) ?? null,
      prSkipNotified: Number(r.pr_skip_notified ?? 0) === 1,
```

Ensure `ChecksState` is imported in `kanban-store.ts` (it already imports feature types from `../../shared/kanban-types`; add `ChecksState` to that import if missing).

- [ ] **Step 8: Run the test, verify it passes** — `npx vitest run src/main/__tests__/kanban-store.test.ts` → PASS. Then `npm run typecheck` → clean.

- [ ] **Step 9: Commit**

```bash
git add src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/shared/kanban-types.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): schema v12 feature PR-lifecycle columns"
```

---

## Task 2: workspace git ops — draft flag, push-only, mark-ready

Three additions to `src/main/kanban/workspace.ts`. These are thin `git`/`gh` wrappers (no unit tests of their own — they're verified through the dispatcher's `IntegrationOps` mocks in later tasks, matching the #228 house style). The key requirement: results must distinguish **deterministic "no remote / no gh"** (→ caller sets the fire-once skip flag) from **transient** failures (→ caller retries next tick).

**Files:**
- Modify: `src/main/kanban/workspace.ts` (`ghPrCreate` 503-539, `createFeaturePr` 697-713; add two new exports)

- [ ] **Step 1: Add a `draft` flag + `noGh` tag to `ghPrCreate`** — `src/main/kanban/workspace.ts:503-539`:

```ts
function ghPrCreate(input: {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
}): { ok: boolean; url?: string; number?: number; noGh?: boolean; error?: string } {
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        input.base,
        '--head',
        input.head,
        '--title',
        input.title,
        '--body',
        input.body || input.title,
        ...(input.draft ? ['--draft'] : [])
      ],
      { cwd: input.cwd, encoding: 'utf8' }
    );
    const url = out.match(/https?:\/\/\S+/)?.[0] ?? out.trim();
    return { ok: true, url, number: prNumberFromUrl(url) };
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') {
      return { ok: false, noGh: true, error: 'gh CLI not found. Install GitHub CLI to create PRs.' };
    }
    const msg = (e.stderr?.toString() || e.stdout?.toString() || (err as Error).message).trim();
    const existing = msg.match(/https?:\/\/\S+/)?.[0];
    if (existing) return { ok: true, url: existing, number: prNumberFromUrl(existing) };
    return { ok: false, error: `gh pr create failed: ${msg}` };
  }
}
```

- [ ] **Step 2: Add `draft` + `noRemote`/`noGh` to `createFeaturePr`** — `src/main/kanban/workspace.ts:697-713`:

```ts
export function createFeaturePr(input: {
  repoPath: string;
  integrationBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}): { ok: boolean; url?: string; number?: number; noRemote?: boolean; noGh?: boolean; error?: string } {
  const { repoPath, integrationBranch, baseBranch, title, body, draft } = input;
  try {
    execFileSync('git', ['-C', repoPath, 'push', '-u', 'origin', integrationBranch], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (err) {
    return { ok: false, noRemote: true, error: `git push failed (no 'origin' remote?): ${gitStderr(err)}` };
  }
  return ghPrCreate({ cwd: repoPath, base: baseBranch, head: integrationBranch, title, body, draft });
}
```

- [ ] **Step 3: Add `pushIntegrationBranch`** (push-only, for subsequent merges) — add near `createFeaturePr` in `src/main/kanban/workspace.ts`:

```ts
/**
 * Push a feature's integration branch to origin without touching its PR (the PR
 * updates itself from the pushed commits). Used for the 2nd+ task merge once the
 * draft PR already exists.
 */
export function pushIntegrationBranch(input: {
  repoPath: string;
  integrationBranch: string;
}): { ok: boolean; noRemote?: boolean; error?: string } {
  try {
    execFileSync('git', ['-C', input.repoPath, 'push', 'origin', input.integrationBranch], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, noRemote: true, error: `git push failed (no 'origin' remote?): ${gitStderr(err)}` };
  }
}
```

- [ ] **Step 4: Add `markPrReady`** (`gh pr ready <n>`) — add near `createFeaturePr`:

```ts
/** Flip a draft PR to "ready for review" via `gh pr ready <number>`, run in repoPath. */
export function markPrReady(input: {
  repoPath: string;
  prNumber: number;
}): { ok: boolean; noGh?: boolean; error?: string } {
  try {
    execFileSync('gh', ['pr', 'ready', String(input.prNumber)], {
      cwd: input.repoPath,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') return { ok: false, noGh: true, error: 'gh CLI not found' };
    const msg = (e.stderr?.toString() || e.stdout?.toString() || (err as Error).message).trim();
    // `gh` errors when the PR is already non-draft; treat that as success (idempotent).
    if (/not a draft|already/i.test(msg)) return { ok: true };
    return { ok: false, error: `gh pr ready failed: ${msg}` };
  }
}
```

- [ ] **Step 5: Verify** — `npm run typecheck` → clean. (No test file here; behavior is covered in Tasks 4–6 via the seam.)

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/workspace.ts
git commit -m "feat(kanban): draft flag + push-only + mark-ready git ops"
```

---

## Task 3: Extend the IntegrationOps seam + feature-PR store mutators

Wire the three new workspace ops into the dispatcher's injectable seam, and add the store mutators the dispatcher will call.

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts:44-60` (interface + defaults; imports)
- Modify: `src/main/kanban/kanban-store.ts` (`setFeaturePr` 1380-1386; add `setFeaturePrState`, `setFeaturePrSkipNotified`)
- Modify: `src/main/__tests__/kanban-dispatcher.test.ts:402-412` (`fakeIntegration` builder)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing store test** — append to `src/main/__tests__/kanban-store.test.ts`:

```ts
it('setFeaturePr stores prState; setFeaturePrState + skip flag mutate it', () => {
  const store = makeStore();
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  store.setFeaturePr(f.id, 'https://x/pull/7', 7, 'draft');
  expect(store.getFeature(f.id)!.prState).toBe('draft');
  store.setFeaturePrState(f.id, 'open');
  expect(store.getFeature(f.id)!.prState).toBe('open');
  store.setFeaturePrSkipNotified(f.id);
  expect(store.getFeature(f.id)!.prSkipNotified).toBe(true);
  store.close();
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run src/main/__tests__/kanban-store.test.ts` → FAIL (`setFeaturePr` takes 3 args; `setFeaturePrState`/`setFeaturePrSkipNotified` undefined).

- [ ] **Step 3: Make `setFeaturePr` take a `prState`** — `src/main/kanban/kanban-store.ts:1380-1386`:

```ts
  /** Record the single feature→main PR on a feature (set when it ships or auto-drafts). */
  setFeaturePr(
    featureId: string,
    prUrl: string,
    prNumber: number | null,
    prState: PrState = 'open'
  ): void {
    this.db
      .prepare(`UPDATE features SET pr_url=?, pr_number=?, pr_state=?, updated_at=? WHERE id=?`)
      .run(prUrl, prNumber, prState, this.now(), featureId);
  }
```

Ensure `PrState` is imported in `kanban-store.ts` (add to the `../../shared/kanban-types` import if missing).

- [ ] **Step 4: Add the two new mutators** — directly after `setFeaturePr`:

```ts
  /** Flip a feature PR's state in place (e.g. draft -> open when marked ready). */
  setFeaturePrState(featureId: string, prState: PrState): void {
    this.db
      .prepare(`UPDATE features SET pr_state=?, updated_at=? WHERE id=?`)
      .run(prState, this.now(), featureId);
  }

  /** Mark that the "PR skipped: no remote/gh" event has been posted for this feature (fire-once). */
  setFeaturePrSkipNotified(featureId: string): void {
    this.db
      .prepare(`UPDATE features SET pr_skip_notified=1, updated_at=? WHERE id=?`)
      .run(this.now(), featureId);
  }
```

- [ ] **Step 5: Extend `IntegrationOps`** — `src/main/kanban/kanban-dispatcher.ts`. Add the three fns to the import from `./workspace` (alongside `ensureFeatureBranch`, etc.), then to the interface (44-51) and defaults (53-60):

```ts
export interface IntegrationOps {
  ensureFeatureBranch: typeof ensureFeatureBranch;
  checkMergeConflicts: typeof checkMergeConflicts;
  mergeWorktreeToBase: typeof mergeWorktreeToBase;
  updateIntegrationBranchFromMain: typeof updateIntegrationBranchFromMain;
  removeWorktree: typeof removeWorktree;
  isBranchMerged: typeof isBranchMerged;
  createFeaturePr: typeof createFeaturePr;
  pushIntegrationBranch: typeof pushIntegrationBranch;
  markPrReady: typeof markPrReady;
}

const DEFAULT_INTEGRATION_OPS: IntegrationOps = {
  ensureFeatureBranch,
  checkMergeConflicts,
  mergeWorktreeToBase,
  updateIntegrationBranchFromMain,
  removeWorktree,
  isBranchMerged,
  createFeaturePr,
  pushIntegrationBranch,
  markPrReady
};
```

- [ ] **Step 6: Extend the test `fakeIntegration` builder** — `src/main/__tests__/kanban-dispatcher.test.ts:402-412`, add defaults so existing tests keep compiling:

```ts
function fakeIntegration(over: Partial<IntegrationOps> = {}): IntegrationOps {
  return {
    ensureFeatureBranch: () => ({ ok: true }),
    checkMergeConflicts: () => ({ state: 'clean', files: [] }),
    mergeWorktreeToBase: () => ({ ok: true }),
    updateIntegrationBranchFromMain: () => ({ ok: true, alreadyUpToDate: true }),
    removeWorktree: () => ({ branchKept: false }),
    isBranchMerged: () => false,
    createFeaturePr: () => ({ ok: true, url: 'https://x/pull/1', number: 1 }),
    pushIntegrationBranch: () => ({ ok: true }),
    markPrReady: () => ({ ok: true }),
    ...over
  };
}
```

- [ ] **Step 7: Verify** — `npx vitest run src/main/__tests__/kanban-store.test.ts` → PASS; `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts` → existing tests still PASS; `npm run typecheck` → clean.

- [ ] **Step 8: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): IntegrationOps PR ops + feature-PR store mutators"
```

---

## Task 4: Dispatcher — `ensureFeaturePr()` (draft on first merge, push after)

After a task merges cleanly into its feature's integration branch, publish the feature: first merge → push + draft PR; subsequent merges → push only. No remote / no gh → post **one** `feature_pr_skipped` event (guarded by `pr_skip_notified`) and never retry. Transient failures leave the flag unset so a later merge retries, and append no event (no per-tick spam — guardrail spec §6).

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (new private method; call site in `integrateTasks` after line 517)
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

- [ ] **Step 1: Write the failing tests** — add to the `describe('KanbanDispatcher.integrate', …)` block in `src/main/__tests__/kanban-dispatcher.test.ts` (reuse the existing `reviewFeatureTask` helper at line ~970):

```ts
it('integrate: first clean merge opens a draft feature PR', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { f, t } = reviewFeatureTask(store);
  let drafted: { draft?: boolean } | null = null;
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t,
    isAlive: () => true,
    spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({
      createFeaturePr: (i) => {
        drafted = { draft: i.draft };
        return { ok: true, url: 'https://x/pull/9', number: 9 };
      }
    })
  });
  disp.integrate();
  expect(drafted).toEqual({ draft: true });
  const got = store.getFeature(f.id)!;
  expect(got.prNumber).toBe(9);
  expect(got.prState).toBe('draft');
  expect(store.getTask(t.id)!.status).toBe('done');
  store.close();
});

it('integrate: second merge pushes only (no second PR create)', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { f } = reviewFeatureTask(store);
  store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft'); // PR already exists
  let created = 0;
  let pushed = 0;
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t,
    isAlive: () => true,
    spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({
      createFeaturePr: () => { created++; return { ok: true, url: 'https://x/pull/9', number: 9 }; },
      pushIntegrationBranch: () => { pushed++; return { ok: true }; }
    })
  });
  disp.integrate();
  expect(created).toBe(0);
  expect(pushed).toBe(1);
  store.close();
});

it('integrate: no remote -> one feature_pr_skipped event, fire-once', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { f } = reviewFeatureTask(store);
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t,
    isAlive: () => true,
    spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({
      createFeaturePr: () => ({ ok: false, noRemote: true, error: 'no origin' })
    })
  });
  disp.integrate();
  expect(store.getFeature(f.id)!.prSkipNotified).toBe(true);
  const skips = store.listEvents(f.id).filter((e) => e.kind === 'feature_pr_skipped');
  expect(skips).toHaveLength(1);
  store.close();
});
```

> If the events accessor in this test file is named differently than `listEvents(featureId)`, use whatever the file already uses to read a feature's events (grep the test file for `.kind ===` to find the existing accessor).

- [ ] **Step 2: Run them, verify they fail** — `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts` → the three new tests FAIL (draft not opened, `prSkipNotified` false).

- [ ] **Step 3: Add the `ensureFeaturePr` method** — in `src/main/kanban/kanban-dispatcher.ts`, add a private method (place it just below `integrateTasks`, before `integrateFeatures`):

```ts
  /**
   * Publish a feature as one PR after a member task merges: first merge opens a
   * draft PR (push + `gh pr create --draft`); later merges push only (the PR
   * self-updates). No remote / no gh -> one deduped `feature_pr_skipped` event,
   * never retried. All best-effort: failures append an event, never throw.
   */
  private ensureFeaturePr(featureId: string | null): void {
    if (!featureId) return;
    const f = this.store.getFeature(featureId);
    if (!f || !f.repoPath || !f.baseBranch) return;
    const integrationBranch = f.integrationBranch ?? `fleet/feature-${f.id}`;

    if (f.prNumber != null) {
      const r = this.ops.pushIntegrationBranch({ repoPath: f.repoPath, integrationBranch });
      if (!r.ok) this.store.appendEvent(featureId, null, 'feature_push_failed', { error: r.error });
      return;
    }
    if (f.prSkipNotified) return; // already gave up on remote for this feature

    const r = this.ops.createFeaturePr({
      repoPath: f.repoPath,
      integrationBranch,
      baseBranch: f.baseBranch,
      title: f.name,
      body: `Auto-opened draft PR for feature "${f.name}".`,
      draft: true
    });
    if (r.ok && r.url) {
      this.store.setFeaturePr(featureId, r.url, r.number ?? null, 'draft');
      this.store.appendEvent(featureId, null, 'feature_pr_created', {
        url: r.url,
        number: r.number,
        draft: true
      });
    } else if (r.noRemote || r.noGh) {
      this.store.setFeaturePrSkipNotified(featureId);
      this.store.appendEvent(featureId, null, 'feature_pr_skipped', { reason: r.error });
    }
    // transient error: no flag, no event -> retried on the next merge
  }
```

- [ ] **Step 4: Call it from the merge-success block** — `src/main/kanban/kanban-dispatcher.ts`, inside `integrateTasks`, in the `if (res.ok) { … }` block, after `this.store.resetResolveAttempts(task.id);` (line 517) and before `budget -= 1;`:

```ts
        this.store.resetResolveAttempts(task.id);
        this.ensureFeaturePr(task.featureId);
        budget -= 1;
```

- [ ] **Step 5: Run the tests, verify they pass** — `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts` → all PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): auto-open draft feature PR on first task merge"
```

---

## Task 5: Dispatcher — `markFeaturePrReady()` (flip draft → ready when done + synced)

When a feature is fully done and its integration branch is cleanly synced with main, flip its draft PR to ready. Hook both existing "synced" points in `integrateFeatures`. Both sit behind the `mergeState='in_progress'` fire-once guard (line 589), so the flip happens at most once. Best-effort: failure appends `feature_pr_ready_failed` (the manual Ship button remains the override).

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (new private method; call sites after lines 580 and 597)
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test** — add to the integrate describe block. This drives the clean-sync path (line 591-598): all tasks done, branch ahead of base (`isBranchMerged` of integration-vs-base = false), sync ok:

```ts
it('integrate: all-done + clean sync flips draft PR to ready', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  store.updateFeature(f.id, {
    integrationBranch: `fleet/feature-${f.id}`,
    repoPath: '/repo',
    baseBranch: 'main'
  });
  store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
  const t = store.createTask({
    title: 't', featureId: f.id, workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main'
  });
  store.setWorkspace(t.id, '/tmp/t', 'br-t', 'main');
  store.reviewTask(t.id, null);
  store.completeTask(t.id, null); // feature now all-done
  let readied = 0;
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t,
    isAlive: () => true,
    spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({
      // integration branch is ahead of base (has merged work) -> not merged into base yet
      isBranchMerged: ({ branchName, baseBranch }) =>
        branchName === 'main' && baseBranch === `fleet/feature-${f.id}` ? false : false,
      updateIntegrationBranchFromMain: () => ({ ok: true, alreadyUpToDate: true }),
      markPrReady: (i) => { readied = i.prNumber; return { ok: true }; }
    })
  });
  disp.integrate();
  expect(readied).toBe(9);
  expect(store.getFeature(f.id)!.prState).toBe('open');
  const ev = store.listEvents(f.id).filter((e) => e.kind === 'feature_pr_ready');
  expect(ev).toHaveLength(1);
  store.close();
});

it('integrate: non-draft feature PR is not re-readied', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  store.updateFeature(f.id, {
    integrationBranch: `fleet/feature-${f.id}`, repoPath: '/repo', baseBranch: 'main'
  });
  store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'open'); // already ready
  const t = store.createTask({
    title: 't', featureId: f.id, workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main'
  });
  store.setWorkspace(t.id, '/tmp/t', 'br-t', 'main');
  store.reviewTask(t.id, null);
  store.completeTask(t.id, null);
  let readied = 0;
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true, spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({ markPrReady: (i) => { readied = i.prNumber; return { ok: true }; } })
  });
  disp.integrate();
  expect(readied).toBe(0);
  store.close();
});
```

> Verify the exact arg shape of `isBranchMerged` in `workspace.ts` and mirror it; the dispatcher calls it twice (integration-vs-base at line 543, base-vs-integration at line 559). The test only needs both to return `false` so the clean-sync branch (591) runs.

- [ ] **Step 2: Run them, verify they fail** — `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts` → the ready test FAILs (`markPrReady` not called, `prState` stays `draft`).

- [ ] **Step 3: Add the `markFeaturePrReady` method** — in `src/main/kanban/kanban-dispatcher.ts`, just below `ensureFeaturePr`:

```ts
  /**
   * Flip a feature's draft PR to ready once the feature is fully done and its
   * integration branch is cleanly synced with main. Best-effort: a failure
   * appends an event and leaves the draft for the manual Ship override.
   */
  private markFeaturePrReady(feature: Feature): void {
    if (feature.prState !== 'draft' || feature.prNumber == null || !feature.repoPath) return;
    const r = this.ops.markPrReady({ repoPath: feature.repoPath, prNumber: feature.prNumber });
    if (r.ok) {
      this.store.setFeaturePrState(feature.id, 'open');
      this.store.appendEvent(feature.id, null, 'feature_pr_ready', { number: feature.prNumber });
    } else {
      this.store.appendEvent(feature.id, null, 'feature_pr_ready_failed', { error: r.error });
    }
  }
```

(`Feature` is already imported in this file — it's used in `createFeatureSyncTask`.)

- [ ] **Step 4: Call it at both synced points** — in `integrateFeatures`:
  - after line 580 (`this.store.updateFeature(feature.id, { mergeState: 'in_progress' });` in the post-resolve `synced` branch): add `this.markFeaturePrReady(feature);`
  - after line 597 (`this.store.updateFeature(feature.id, { mergeState: 'in_progress' });` in the `sync.ok` branch): add `this.markFeaturePrReady(feature);`

`feature` is the row read at the top of the loop; its `prState`/`prNumber` are current (the draft was created in an earlier `integrateTasks` pass), so no re-read is needed.

- [ ] **Step 5: Run the tests, verify they pass** — `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts` → all PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): flip feature draft PR to ready on completion"
```

---

## Task 6: Manual Ship button becomes a real override (draft → ready)

Today `shipFeature` always calls `createFeaturePr`. If autopilot already opened a draft, clicking Ship should flip it to ready rather than re-create. Make Ship: if a draft PR exists, mark it ready; otherwise create an open PR as before.

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts:1028-1058` (`shipFeature`; add `markPrReady` import)
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing test** — in `src/main/__tests__/kanban-commands.test.ts`, follow the file's existing harness for constructing `KanbanCommands` with a fake/temp git repo. Drive Ship on a feature that already has a draft PR and assert it ends `open`. (Grep the file for an existing `shipFeature` or feature test to copy the setup; if `createFeaturePr`/`markPrReady` are not already injectable at the commands layer, this test should at minimum assert that Ship on a `prState: 'draft'` feature sets `prState: 'open'` and emits a `feature_pr_ready` event, using whatever workspace-stubbing the file already does.) Example shape:

```ts
it('shipFeature flips an existing draft PR to ready instead of recreating', async () => {
  const { commands, store } = makeCommandsWithRepo(); // existing helper pattern in this file
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  store.updateFeature(f.id, {
    integrationBranch: `fleet/feature-${f.id}`, repoPath: REPO, baseBranch: 'main'
  });
  store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
  const res = commands.shipFeature(f.id);
  expect(res.ok).toBe(true);
  expect(store.getFeature(f.id)!.prState).toBe('open');
  expect(store.listEvents(f.id).some((e) => e.kind === 'feature_pr_ready')).toBe(true);
});
```

> If `kanban-commands.test.ts` has no existing real-repo Ship harness, prefer to cover this behavior in `kanban-dispatcher.test.ts` is NOT applicable (Ship is a commands method). In that case, keep the assertion minimal and stub `updateIntegrationBranchFromMain`/`markPrReady` if the file already stubs workspace fns; otherwise skip the automated test and rely on the typecheck + a manual note in the PR that Ship-override is covered by inspection. Decide based on what the file already supports — do not introduce a new mocking framework.

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run src/main/__tests__/kanban-commands.test.ts` → FAIL (Ship leaves `prState` `draft` / recreates).

- [ ] **Step 3: Add the override branch** — `src/main/kanban/kanban-commands.ts`. Add `markPrReady` to the `./workspace` import, then in `shipFeature`, after the successful `sync` pre-flight (after line 1039) and before the `createFeaturePr` call:

```ts
    // Override: a draft already exists (autopilot opened it) -> just mark it ready.
    if (feature.prNumber != null && feature.prState === 'draft') {
      const ready = markPrReady({ repoPath, prNumber: feature.prNumber });
      if (!ready.ok) {
        this.store.appendEvent(featureId, null, 'feature_pr_ready_failed', { error: ready.error });
        return { ok: false, error: ready.error };
      }
      this.store.setFeaturePrState(featureId, 'open');
      this.store.appendEvent(featureId, null, 'feature_pr_ready', { number: feature.prNumber });
      return { ok: true, prUrl: feature.prUrl ?? undefined, message: 'feature PR marked ready' };
    }
```

The existing `createFeaturePr` path stays as the fallback for features with no PR yet.

- [ ] **Step 4: Run the test, verify it passes** — `npx vitest run src/main/__tests__/kanban-commands.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): Ship override marks existing draft PR ready"
```

---

## Task 7: PrPoller keeps feature-PR state fresh

Extend the existing poller (currently task-only) to also refresh feature PRs by number, writing `pr_state` + `checks_state` and bumping `pr_synced_at`. This satisfies spec §3 ("`PrPoller` (existing) keeps `prState`/`checksState` fresh").

**Files:**
- Modify: `src/main/kanban/kanban-store.ts` (add `featuresDuePrSync`, `setFeaturePrStatus`)
- Modify: `src/main/kanban/pr-poller.ts` (sweep features after tasks)
- Test: `src/main/__tests__/kanban-store.test.ts` (store methods) + a new `src/main/__tests__/kanban-pr-poller.test.ts` (feature sweep)

- [ ] **Step 1: Write the failing store test** — append to `src/main/__tests__/kanban-store.test.ts`:

```ts
it('featuresDuePrSync returns features with a PR number past the cutoff; setFeaturePrStatus updates + stamps', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
  expect(store.featuresDuePrSync(clock.t, 10).map((x) => x.id)).toContain(f.id);
  store.setFeaturePrStatus(f.id, { prState: 'open', checksState: 'passing' });
  const got = store.getFeature(f.id)!;
  expect(got.prState).toBe('open');
  expect(got.checksState).toBe('passing');
  expect(got.syncedAt).toBe(clock.t);
  // just-synced feature is now skipped by the same cutoff
  expect(store.featuresDuePrSync(clock.t - 1, 10).map((x) => x.id)).not.toContain(f.id);
  store.close();
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run src/main/__tests__/kanban-store.test.ts` → FAIL (methods undefined).

- [ ] **Step 3: Add the store methods** — `src/main/kanban/kanban-store.ts`, near the other feature methods:

```ts
  /** Active features with a PR number not polled since `cutoff` (oldest first), capped at `limit`. */
  featuresDuePrSync(cutoff: number, limit: number): Feature[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM features
           WHERE status='active' AND pr_number IS NOT NULL
             AND (pr_synced_at IS NULL OR pr_synced_at <= @cutoff)
           ORDER BY pr_synced_at ASC NULLS FIRST
           LIMIT @limit`
      )
      .all({ cutoff, limit }) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToFeature(r));
  }

  /** Write polled feature-PR state and bump pr_synced_at so the next sweep skips it. */
  setFeaturePrStatus(
    featureId: string,
    fields: { prState: PrState | null; checksState: ChecksState | null }
  ): void {
    const ts = this.now();
    this.db
      .prepare(`UPDATE features SET pr_state=?, checks_state=?, pr_synced_at=?, updated_at=? WHERE id=?`)
      .run(fields.prState, fields.checksState, ts, ts, featureId);
  }
```

> `NULLS FIRST` is supported by the bundled SQLite (better-sqlite3 ships ≥3.30). If a test environment rejects it, fall back to `ORDER BY COALESCE(pr_synced_at, 0) ASC`.

- [ ] **Step 4: Run the store test, verify it passes** — `npx vitest run src/main/__tests__/kanban-store.test.ts` → PASS.

- [ ] **Step 5: Write the failing poller test** — create `src/main/__tests__/kanban-pr-poller.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PrPoller } from '../kanban/pr-poller';
import { makeStore } from './kanban-store.test-helpers'; // OR construct the store the way kanban-store.test.ts does

describe('PrPoller feature sweep', () => {
  it('writes feature prState/checksState from gh and emits feature_pr_synced', () => {
    const clock = { t: 100_000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'F' });
    store.updateFeature(f.id, { repoPath: '/repo' });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
    const poller = new PrPoller(store, {
      now: () => clock.t,
      fetchPrState: () => ({
        ok: true, state: 'open', checksState: 'passing', mergeState: 'CLEAN',
        url: 'https://x/pull/9', number: 9
      })
    });
    poller.sweep();
    const got = store.getFeature(f.id)!;
    expect(got.prState).toBe('open');
    expect(got.checksState).toBe('passing');
    expect(store.listEvents(f.id).some((e) => e.kind === 'feature_pr_synced')).toBe(true);
    store.close();
  });
});
```

> Use the same store-construction the existing `kanban-store.test.ts` uses (copy its `makeStore`/temp-db setup inline if there is no shared helper module — do not invent an import that doesn't exist).

- [ ] **Step 6: Run it, verify it fails** — `npx vitest run src/main/__tests__/kanban-pr-poller.test.ts` → FAIL (poller doesn't touch features).

- [ ] **Step 7: Add the feature sweep to the poller** — `src/main/kanban/pr-poller.ts`. Add constants near the top, then a `sweepFeatures()` and call it at the end of `sweep()`:

```ts
// (top, with the other constants)
const FEATURE_BATCH = 10;
```

In `sweep()`, after the task loop (`for (const task of due) { … }`) and before the method returns, add:

```ts
    this.sweepFeatures(now);
```

Add the method:

```ts
  /** Poll active feature PRs by number, writing back prState/checksState. */
  private sweepFeatures(now: number): void {
    const due = this.store.featuresDuePrSync(now - MIN_SYNC_GAP_MS, FEATURE_BATCH);
    for (const feature of due) {
      if (feature.prNumber == null) continue;
      const cwd = feature.repoPath;
      if (!cwd) continue;
      const res = this.fetch({ workspacePath: cwd, prRef: String(feature.prNumber) });
      if (!res.ok) {
        if (res.noGh) return;
        if (res.rateLimited) {
          this.rateLimitedUntil = this.deps.now() + RATE_LIMIT_BACKOFF_MS;
          return;
        }
        if (res.notFound) {
          this.store.setFeaturePrStatus(feature.id, { prState: null, checksState: null });
          this.store.appendEvent(feature.id, null, 'feature_pr_synced', { state: null });
        }
        continue;
      }
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
    }
  }
```

(`RATE_LIMIT_BACKOFF_MS` and `MIN_SYNC_GAP_MS` already exist in this file.)

- [ ] **Step 8: Run the poller test, verify it passes** — `npx vitest run src/main/__tests__/kanban-pr-poller.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 9: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/kanban/pr-poller.ts src/main/__tests__/kanban-store.test.ts src/main/__tests__/kanban-pr-poller.test.ts
git commit -m "feat(kanban): PrPoller refreshes feature-PR state"
```

---

## Task 8: UI — FeaturePrRollup shows draft vs ready

Surface `feature.prState` in the rollup strip so a draft PR reads "draft PR" and a ready one reads "feature PR" (with a checks badge from the feature when present). Minimal change — no new component.

**Files:**
- Modify: `src/renderer/src/components/kanban/FeaturePrRollup.tsx:69-78` (the `feature.prUrl` link)

- [ ] **Step 1: Show draft vs ready on the PR link** — replace the `{feature.prUrl && ( … )}` block (lines 69-78) with:

```tsx
      {feature.prUrl && (
        <a
          href={feature.prUrl}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex items-center gap-1 underline ${
            feature.prState === 'draft' ? 'text-neutral-400' : 'text-violet-300'
          }`}
        >
          <Rocket size={11} /> {feature.prState === 'draft' ? 'draft PR' : 'feature PR'}
        </a>
      )}
```

- [ ] **Step 2: Verify** — `npm run typecheck` → clean. Optionally `npm run build` to confirm the renderer compiles. (No unit test — presentational only.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/kanban/FeaturePrRollup.tsx
git commit -m "feat(kanban): show draft vs ready feature PR in rollup"
```

---

## Task 9: Notification on feature PR ready

Spec §3 calls for a notification when a feature flips to ready. The notifier is task-keyed (`enqueue` drops events whose `getTask(taskId)` is null, and feature events use `taskId = featureId`). Map `feature_pr_ready → completed` and let the notifier resolve a feature title when the task lookup misses.

**Files:**
- Modify: `src/shared/kanban-notifications.ts:15-29` (`classifyKanbanEvent`)
- Modify: `src/main/kanban/kanban-notifier.ts` (deps + `enqueue` fallback)
- Modify: `src/main/index.ts` (wire the new dep)
- Test: `src/main/__tests__/kanban-notifier.test.ts`

- [ ] **Step 1: Write the failing test** — in `src/main/__tests__/kanban-notifier.test.ts`, copy the existing single-event test setup and assert a `feature_pr_ready` event for a feature-id produces one `completed` notification whose body contains the feature name. Match the file's existing deps/harness exactly (it constructs `KanbanNotifier` with `getTask`, `present`, `isOsEnabled`, etc.):

```ts
it('feature_pr_ready notifies as completed using the feature name', () => {
  const presented: Array<{ body: string }> = [];
  const notifier = new KanbanNotifier({
    // ...copy the other deps from the existing tests...
    getTask: () => undefined,
    getFeature: (id: string) => (id === 'feat1' ? ({ id, name: 'My Feature', boardId: 'default' } as Feature) : null),
    isOsEnabled: () => true,
    present: (n) => presented.push(n),
    batchMs: 0
  });
  notifier.enqueue({ taskId: 'feat1', kind: 'feature_pr_ready' } as TaskEvent);
  notifier.flush();
  expect(presented).toHaveLength(1);
  expect(presented[0].body).toContain('My Feature');
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run src/main/__tests__/kanban-notifier.test.ts` → FAIL (`getFeature` not a dep; event dropped).

- [ ] **Step 3: Classify the event** — `src/shared/kanban-notifications.ts`, add a case to `classifyKanbanEvent`:

```ts
    case 'completed':
    case 'feature_pr_ready':
      return 'completed';
```

- [ ] **Step 4: Add the `getFeature` fallback to the notifier** — `src/main/kanban/kanban-notifier.ts`. Add `getFeature: (id: string) => Feature | null` to `KanbanNotifierDeps`, and in `enqueue` (59-72) resolve the title/board from a task first, then a feature:

```ts
  enqueue(event: TaskEvent): void {
    const category = classifyKanbanEvent(event.kind);
    if (!category) return;
    if (!this.deps.isOsEnabled(category)) return;
    const task = this.deps.getTask(event.taskId);
    const feature = task ? null : this.deps.getFeature(event.taskId);
    const subject = task ?? feature;
    if (!subject) return;
    this.buffer.push({
      category,
      taskId: event.taskId,
      boardSlug: subject.boardId,
      title: task ? task.title : (feature as Feature).name
    });
    this.timer ??= setTimeout(() => this.flush(), this.batchMs);
  }
```

Import `Feature` from `../../shared/kanban-types` in the notifier.

- [ ] **Step 5: Wire the dep** — `src/main/index.ts`, where `KanbanNotifier` is constructed, add `getFeature: (id) => kanbanStore.getFeature(id)` to its deps (mirror the existing `getTask` wiring). Grep `index.ts` for `new KanbanNotifier` to find the exact site.

- [ ] **Step 6: Run the test, verify it passes** — `npx vitest run src/main/__tests__/kanban-notifier.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/shared/kanban-notifications.ts src/main/kanban/kanban-notifier.ts src/main/index.ts src/main/__tests__/kanban-notifier.test.ts
git commit -m "feat(kanban): notify when a feature PR flips to ready"
```

---

## Final verification

- [ ] **Full suite:** `npm test` → all green (no regressions in the ~1069-test suite).
- [ ] **Types + lint:** `npm run typecheck` clean; `npm run lint` shows no NEW errors vs. the pre-existing baseline (the repo lint baseline is red — compare, don't expect zero).
- [ ] **Build:** `npm run build` succeeds.
- [ ] **Manual smoke (optional, needs a gh-authed repo):** create a feature with 2 worktree tasks, complete the first → confirm a draft PR opens (`gh pr view` shows `isDraft: true`); complete the second → confirm the PR flips to ready and a `feature_pr_ready` event + notification fire.
- [ ] **Changelog:** add a `## vX.Y.Z` entry for this feature in `CHANGELOG.md` (per repo convention) — but only at release time; not part of the feature commits unless the user asks.

---

## Notes carried from #228 (constraints for this issue)

- **Phase boundary opens here:** origin push + `gh pr create --draft` + `gh pr ready` are now in-scope (they were explicitly deferred from #228 to #229). This applies to the *autopilot's management of the user's managed repos*, exercised through the `IntegrationOps` seam.
- **Guardrails (spec §6):** merges only, never force-push; all git ops best-effort (append events, never throw out of the tick); every automated action appends a task/feature event for the audit trail.
- **No silent per-tick spam:** the `pr_skip_notified` flag guarantees the "no remote/gh" event fires once per feature; transient errors retry without emitting events.
- **House rules:** no `as` casts / no `eslint-disable` in `src`; commits carry the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer; run `npm run typecheck` separately (vitest skips it).
