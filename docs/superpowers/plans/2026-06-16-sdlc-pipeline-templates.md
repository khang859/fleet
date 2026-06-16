# SDLC Pipeline Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add selectable pipeline templates so a `full_feature` ticket flows automatically through explore → spec → (human approval gate) → implement → review → QA while `quick_fix`/NULL keeps today's lightweight work → review flow unchanged.

**Architecture:** A pipeline template is a code-defined ordered list of stages. `template-expander.ts` (mirroring `kanban-swarm.ts`'s `createSwarm`) deterministically lays down explore/spec/gate/qa tasks plus `task_links`; only the implement-children fan-out is LLM-decided by the architect at the spec stage. The approval gate is a `blocked` task released by an `approve_spec` proposal (PM-agent-independent, built on #233). Stage identity lives in `tasks.pipeline_stage`; QA gates the feature PR via `features.qa_verdict`. No new tables, no new process — the existing dispatcher tick drives everything.

**Tech Stack:** Electron + electron-vite + React + TypeScript, better-sqlite3, zod, vitest.

---

## Conventions every task must follow

- Verify with `npm run typecheck` (node + web), `npm run lint` (only NEW issues matter — repo lint is pre-existing-red), and `npx vitest run <file>` for the touched test. Vitest does NOT run typecheck.
- **No unsafe type assertions in `src/`**: use zod for runtime validation, never `as` casts or `eslint-disable`. Casts are allowed ONLY in `*.test.ts` files.
- Main/preload output ESM; never use `__dirname`.
- `SCHEMA_SQL` runs BEFORE migrations: add new columns to the `CREATE TABLE` in `schema.ts` (columns only) AND via `addColumnIfMissing` in the migration block. Never put an index on a migration-added column in `SCHEMA_SQL`.
- Surgical changes; match existing style; do not refactor unrelated code.
- Commit each task with a conventional-commit message and this EXACT footer (use a HEREDOC commit):

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Task 1 — Schema + migration + store accessors (SCHEMA_VERSION 17 → 18)

**Files**
- Modify: `src/main/kanban/schema.ts` (`SCHEMA_VERSION` line 1; `tasks` CREATE TABLE ~line 54 after `system_kind`; `features` CREATE TABLE ~line 137 after `pr_skip_notified`)
- Modify: `src/main/kanban/kanban-store.ts` (`migrate()` ~line 255 after the `current < 17` block; `rowToTask` ~line 336; `rowToFeature` ~line 1450; new `setQaVerdict` near `setReviewVerdict` ~line 1915)
- Modify: `src/main/__tests__/kanban-store.test.ts` (10 `toBe(17)` assertions), `src/main/__tests__/kanban-review-store.test.ts` (1 `toBe(17)`)
- Test: `src/main/__tests__/kanban-store.test.ts`

Steps:

- [ ] In `src/main/kanban/schema.ts` bump the version:

```ts
export const SCHEMA_VERSION = 18;
```

- [ ] In `schema.ts`, add the two task columns to the `tasks` CREATE TABLE, immediately after the `system_kind TEXT,` line (columns only, NO index):

```ts
  system_kind TEXT,
  pipeline_template TEXT,
  pipeline_stage TEXT,
  created_at INTEGER NOT NULL,
```

- [ ] In `schema.ts`, add the feature column to the `features` CREATE TABLE, immediately after `pr_skip_notified INTEGER NOT NULL DEFAULT 0,`:

```ts
  pr_skip_notified INTEGER NOT NULL DEFAULT 0,
  qa_verdict TEXT,
  created_at INTEGER NOT NULL,
```

- [ ] In `kanban-store.ts` `migrate()`, add a new migration block immediately after the `if (current < 17) { ... }` block and before the `// Seed the permanent default board` comment:

```ts
    if (current < 18) {
      // SDLC pipeline templates (#234): stage identity on tasks + a QA verdict on
      // features. Additive, idempotent. The columns are in SCHEMA_SQL for fresh
      // installs; add them here for existing DBs. No new indexes.
      this.addColumnIfMissing('tasks', 'pipeline_template', 'TEXT');
      this.addColumnIfMissing('tasks', 'pipeline_stage', 'TEXT');
      this.addColumnIfMissing('features', 'qa_verdict', 'TEXT');
    }
```

- [ ] In `kanban-store.ts` `rowToTask`, add the two fields right after the `systemKind: ...` line:

```ts
      systemKind: (r.system_kind as string | null) ?? null,
      pipelineTemplate: (r.pipeline_template as Task['pipelineTemplate']) ?? null,
      pipelineStage: (r.pipeline_stage as Task['pipelineStage']) ?? null,
      createdAt: Number(r.created_at),
```

- [ ] In `kanban-store.ts` `createTask`, add the two columns to the INSERT. Update the column list and VALUES list to include `pipeline_template, pipeline_stage` (after `system_kind`), and add to the `.run({...})` object after `system_kind`:

```ts
        system_kind: input.systemKind ?? null,
        pipeline_template: input.pipelineTemplate ?? null,
        pipeline_stage: input.pipelineStage ?? null,
        max_runtime_seconds: input.maxRuntimeSeconds ?? null,
```

(Also add `pipeline_template, pipeline_stage` to the SQL column names list and `@pipeline_template, @pipeline_stage` to the VALUES list, both right after `system_kind`/`@system_kind`.)

- [ ] In `kanban-store.ts` `rowToFeature`, add the field right after `prSkipNotified`:

```ts
      prSkipNotified: Number(r.pr_skip_notified ?? 0) === 1,
      qaVerdict: (r.qa_verdict as Feature['qaVerdict']) ?? null,
      createdAt: Number(r.created_at),
```

- [ ] In `kanban-store.ts`, add a `setQaVerdict` accessor immediately after `setReviewVerdict` (~line 1915):

```ts
  /** Record the feature-level QA verdict (pipeline §8). null clears it. */
  setQaVerdict(featureId: string, verdict: 'pass' | 'request_changes' | null): void {
    this.db
      .prepare('UPDATE features SET qa_verdict=@v, updated_at=@ts WHERE id=@id')
      .run({ id: featureId, v: verdict, ts: this.now() });
  }
```

- [ ] Bump every `toBe(17)` to `toBe(18)`. In `src/main/__tests__/kanban-store.test.ts` these are at lines 28, 37, 44, 75, 100, 121, 144, 166, 593, 1017 (10 total). In `src/main/__tests__/kanban-review-store.test.ts` line 11 (1 total). Use search-and-replace `toBe(17)` → `toBe(18)` in those two files only. (Note: the spec said "12" / "10+1"; the real repo has exactly 11 — 10 + 1.)

- [ ] Add a migration test for the new columns. Append to `src/main/__tests__/kanban-store.test.ts` inside the top-level describe (near the existing schema-version tests):

```ts
  it('persists pipeline columns and qa verdict at schema v18', () => {
    const store = makeStore();
    expect(store.schemaVersion()).toBe(18);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    const t = store.createTask({
      title: 'root',
      pipelineTemplate: 'full_feature',
      pipelineStage: 'explore',
      featureId: f.id
    });
    const got = store.getTask(t.id);
    expect(got?.pipelineTemplate).toBe('full_feature');
    expect(got?.pipelineStage).toBe('explore');
    store.setQaVerdict(f.id, 'pass');
    expect(store.getFeature(f.id)?.qaVerdict).toBe('pass');
    store.close();
  });
```

(Use the file's existing `makeStore()` helper — match how the surrounding tests construct a store. If the local helper is named differently or takes args, mirror the nearest existing schema test in the same file.)

- [ ] Run: `npx vitest run src/main/__tests__/kanban-store.test.ts src/main/__tests__/kanban-review-store.test.ts` — expect all green (the new test passes, all `toBe(18)` pass). Then `npm run typecheck` — note it will FAIL until Task 2 adds the type fields; that is expected. To make this task self-verifiable, Task 2's type changes are a hard prerequisite for typecheck; run only vitest here and defer typecheck to Task 2.

- [ ] Commit:

```
feat(kanban): schema v18 pipeline columns + qa_verdict + setQaVerdict
```

---

## Task 2 — Shared types (RunMode, role, PmProposalKind, pipeline types)

**Files**
- Modify: `src/shared/kanban-types.ts` (`RunMode` ~line 18; `Task` ~line 239; `Feature` ~line 97; `PmProposalKind` ~line 296; `PM_PROPOSAL_KINDS` ~line 320; `CreateTaskInput` ~line 404)
- Modify: `src/shared/types.ts` (`WorkerProfile.role` line 150)
- Test: type-only change; verified by `npm run typecheck`

Steps:

- [ ] In `src/shared/kanban-types.ts`, extend `RunMode` (keep the leading-comment intact):

```ts
export type RunMode =
  | 'work'
  | 'decompose'
  | 'specify'
  | 'assign'
  | 'resolve'
  | 'suggest'
  | 'verify'
  | 'review'
  | 'explore'
  | 'spec'
  | 'qa';
```

- [ ] In `src/shared/kanban-types.ts`, add the two pipeline string-literal unions just below the `RunMode` definition:

```ts
/** A pipeline template id carried on the root task. NULL ⇒ behaves as quick_fix. */
export type PipelineTemplateId = 'full_feature' | 'quick_fix';

/** Stage identity carried by generated pipeline tasks. NULL ⇒ ordinary non-pipeline task. */
export type StageKind = 'explore' | 'spec' | 'gate' | 'implement' | 'review' | 'qa';
```

- [ ] In `src/shared/kanban-types.ts`, add fields to the `Task` interface, right after `systemKind: string | null;`:

```ts
  systemKind: string | null;
  /** Template carried by the root task (NULL ⇒ quick_fix / non-pipeline). */
  pipelineTemplate: PipelineTemplateId | null;
  /** Stage identity for a generated pipeline task (NULL ⇒ non-pipeline). */
  pipelineStage: StageKind | null;
  createdAt: number;
```

- [ ] In `src/shared/kanban-types.ts`, add the field to the `Feature` interface, right after `prSkipNotified: boolean;`:

```ts
  prSkipNotified: boolean;
  /** Feature-level QA verdict (pipeline §8). NULL ⇒ not yet QA'd / non-pipeline. */
  qaVerdict: 'pass' | 'request_changes' | null;
  createdAt: number;
```

- [ ] In `src/shared/kanban-types.ts`, extend `PmProposalKind`:

```ts
export type PmProposalKind =
  | 'merge_review_task'
  | 'create_pr_for_task'
  | 'accept_review_task'
  | 'ship_feature'
  | 'complete_task'
  | 'archive_task'
  | 'approve_spec';
```

- [ ] In `src/shared/kanban-types.ts`, add `'approve_spec'` to `PM_PROPOSAL_KINDS`:

```ts
export const PM_PROPOSAL_KINDS = [
  'merge_review_task',
  'create_pr_for_task',
  'accept_review_task',
  'ship_feature',
  'complete_task',
  'archive_task',
  'approve_spec'
] as const satisfies readonly PmProposalKind[];
```

- [ ] In `src/shared/kanban-types.ts`, add to `CreateTaskInput`, right after `systemKind?: string | null;`:

```ts
  systemKind?: string | null;
  pipelineTemplate?: PipelineTemplateId | null;
  pipelineStage?: StageKind | null;
}
```

- [ ] In `src/shared/types.ts` line 150, extend `WorkerProfile.role`:

```ts
  role: 'worker' | 'orchestrator' | 'reviewer' | 'explorer' | 'architect' | 'qa'; // orchestrator drives decompose/specify; reviewer drives code-review runs; explorer/architect/qa drive pipeline stages
```

- [ ] Run: `npm run typecheck` — expect green (Task 1's store fields now satisfy the new `Task`/`Feature`/`CreateTaskInput` shapes). Then `npx vitest run src/main/__tests__/kanban-store.test.ts` — expect green.

- [ ] Commit:

```
feat(kanban): pipeline run modes, roles, proposal kind, and shared types
```

---

## Task 3 — pipeline-templates.ts (template constants + getTemplate lookup)

**Files**
- Create: `src/main/kanban/pipeline-templates.ts`
- Create: `src/main/__tests__/pipeline-templates.test.ts`
- Test: `src/main/__tests__/pipeline-templates.test.ts`

Steps:

- [ ] Create `src/main/kanban/pipeline-templates.ts`:

```ts
import type { PipelineTemplateId, StageKind } from '../../shared/kanban-types';

export interface PipelineTemplate {
  id: PipelineTemplateId;
  /**
   * Ordered stages the expander lays down. Excludes the LLM-fanned implement
   * children + their per-child review, which the architect emits at the spec stage.
   */
  stages: StageKind[];
}

/** Max implement children the architect may fan out at the spec stage (spec §5). */
export const MAX_FANOUT = 12;

/** QA request_changes re-arm cycles before the feature is blocked (spec §8). */
export const QA_ATTEMPT_CAP = 2;

export const FULL_FEATURE: PipelineTemplate = {
  id: 'full_feature',
  stages: ['explore', 'spec', 'gate', 'qa']
};

export const QUICK_FIX: PipelineTemplate = {
  id: 'quick_fix',
  // No expansion: the root task runs today's work → review flow unchanged.
  stages: []
};

/** Look up a template by id. Returns QUICK_FIX for null/unknown (the inert default). */
export function getTemplate(id: PipelineTemplateId | null | undefined): PipelineTemplate {
  return id === 'full_feature' ? FULL_FEATURE : QUICK_FIX;
}
```

- [ ] Create `src/main/__tests__/pipeline-templates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  FULL_FEATURE,
  QUICK_FIX,
  getTemplate,
  MAX_FANOUT,
  QA_ATTEMPT_CAP
} from '../kanban/pipeline-templates';

describe('pipeline-templates', () => {
  it('FULL_FEATURE lays down explore → spec → gate → qa', () => {
    expect(FULL_FEATURE.id).toBe('full_feature');
    expect(FULL_FEATURE.stages).toEqual(['explore', 'spec', 'gate', 'qa']);
  });

  it('QUICK_FIX is inert (no stages)', () => {
    expect(QUICK_FIX.id).toBe('quick_fix');
    expect(QUICK_FIX.stages).toEqual([]);
  });

  it('getTemplate resolves full_feature and falls back to quick_fix', () => {
    expect(getTemplate('full_feature')).toBe(FULL_FEATURE);
    expect(getTemplate('quick_fix')).toBe(QUICK_FIX);
    expect(getTemplate(null)).toBe(QUICK_FIX);
    expect(getTemplate(undefined)).toBe(QUICK_FIX);
  });

  it('caps are the spec values', () => {
    expect(MAX_FANOUT).toBe(12);
    expect(QA_ATTEMPT_CAP).toBe(2);
  });
});
```

- [ ] Run: `npx vitest run src/main/__tests__/pipeline-templates.test.ts` — expect 4 passing. Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): pipeline template constants + getTemplate lookup
```

---

## Task 4 — template-expander.ts (deterministic graph, idempotent, role fallback)

**Files**
- Create: `src/main/kanban/template-expander.ts`
- Create: `src/main/__tests__/template-expander.test.ts`
- Test: `src/main/__tests__/template-expander.test.ts`

Context: this mirrors `createSwarm` in `kanban-swarm.ts`. The store passed in exposes `createTask`, `addLink`, `getTask`, `createFeature`, `getFeature`, `blockTask`, `appendEvent`, `listEvents`. `appendEvent(taskId, runId, kind, payload?)` and `listEvents(taskId)` already exist. Idempotency uses a `pipeline_expanded` event on the root.

Steps:

- [ ] Create `src/main/kanban/template-expander.ts`:

```ts
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { Task } from '../../shared/kanban-types';
import type { PipelineTemplate } from './pipeline-templates';

const log = createLogger('template-expander');

/** Profile roles the full_feature pipeline requires; missing any ⇒ fall back to quick_fix. */
const REQUIRED_ROLES = ['explorer', 'architect', 'qa'] as const;

/** Event kind written on the root once expansion has run, for reclaim-safe idempotency. */
export const PIPELINE_EXPANDED_EVENT = 'pipeline_expanded';

export interface ExpanderDeps {
  /** Profile names present per role, used for the graceful-degradation check. */
  hasRole: (role: string) => boolean;
}

/**
 * Lay down the full_feature skeleton for a triage root task, mirroring createSwarm:
 * ensure a feature, then create explore(ready) → spec(todo) → gate(blocked) → qa(todo)
 * with the gating links. The implement-children fan-out is NOT created here — the
 * architect emits it at the spec stage (§5). Idempotent: re-running is a no-op once
 * the PIPELINE_EXPANDED_EVENT is present. Falls back to quick_fix (no expansion) if a
 * required role profile is missing.
 */
export function expandTemplate(
  root: Task,
  template: PipelineTemplate,
  store: KanbanStore,
  deps: ExpanderDeps
): void {
  if (template.id !== 'full_feature') return; // quick_fix / inert: no expansion

  // Idempotency: a prior expansion left an event on the root.
  if (store.listEvents(root.id).some((e) => e.kind === PIPELINE_EXPANDED_EVENT)) {
    return;
  }

  // Graceful degradation: a missing SDLC role makes the pipeline unrunnable, so
  // degrade to quick_fix (root runs the normal flow) rather than wedging.
  const missing = REQUIRED_ROLES.filter((r) => !deps.hasRole(r));
  if (missing.length > 0) {
    log.warn('pipeline role(s) missing; falling back to quick_fix', {
      rootId: root.id,
      missing
    });
    store.appendEvent(root.id, null, PIPELINE_EXPANDED_EVENT, {
      fallback: 'quick_fix',
      missing
    });
    return; // root stays a triage task and runs today's flow
  }

  store.transaction(() => {
    // 1. Ensure the root has a feature so all stages ship as one unit.
    let featureId = root.featureId;
    if (!featureId) {
      const feature = store.createFeature({
        boardId: root.boardId,
        name: root.title,
        repoPath: root.repoPath,
        baseBranch: root.baseBranch
      });
      featureId = feature.id;
      store.setFeatureId(root.id, featureId);
    }

    const common = {
      boardId: root.boardId,
      featureId,
      repoPath: root.repoPath ?? undefined,
      baseBranch: root.baseBranch ?? null,
      priority: root.priority
    };

    // 2. explore (read-only mapping) — starts ready so it spawns immediately.
    const explore = store.createTask({
      title: `Explore: ${root.title}`,
      body:
        `Map the codebase relevant to root task ${root.id}: affected files/modules/patterns, ` +
        `risks and unknowns. Write NO code. Register findings as a kanban_artifact and post a ` +
        `one-paragraph summary comment on ${root.id}.\n\nRoot:\n${root.body}`,
      assignee: 'explorer',
      status: 'ready',
      pipelineStage: 'explore',
      ...common
    });

    // 3. spec (architect) — gated on explore.
    const spec = store.createTask({
      title: `Spec: ${root.title}`,
      body:
        `Read the explore artifact + root task ${root.id}, write a concrete implementation spec, ` +
        `then fan out implementation work by calling kanban_create once per unit (the create path ` +
        `wires links + feature for you). Do not implement. Root:\n${root.body}`,
      assignee: 'architect',
      status: 'todo',
      pipelineStage: 'spec',
      ...common
    });
    store.addLink(explore.id, spec.id);

    // 4. gate — blocked; only executeProposal('approve_spec') moves it to done.
    const gate = store.createTask({
      title: `Approve spec: ${root.title}`,
      body: `Spec approval gate for feature ${featureId}. Released only by an approve_spec proposal.`,
      status: 'blocked',
      systemKind: 'pipeline_gate',
      pipelineStage: 'gate',
      ...common
    });
    store.addLink(spec.id, gate.id);

    // 5. qa — gated on the gate (baseline; implement children also link → qa in §5).
    const qa = store.createTask({
      title: `QA: ${root.title}`,
      body:
        `Validate feature ${featureId} against root task ${root.id}'s acceptance criteria. Run the ` +
        `project verify commands, exercise end-to-end behavior, check explore-identified risks, then ` +
        `emit a verdict.`,
      assignee: 'qa',
      status: 'todo',
      pipelineStage: 'qa',
      ...common
    });
    store.addLink(gate.id, qa.id);

    // 6. Idempotency marker + audit record of the laid-down graph.
    store.appendEvent(root.id, null, PIPELINE_EXPANDED_EVENT, {
      featureId,
      exploreId: explore.id,
      specId: spec.id,
      gateId: gate.id,
      qaId: qa.id
    });
    // The root is the planning anchor; complete it so it doesn't sit in triage.
    store.completeTask(root.id, 'Pipeline expanded; stages laid down.');
  });
}
```

- [ ] In `src/main/kanban/kanban-store.ts`, add a `setFeatureId` accessor (the expander calls it; verify it does not already exist — if it does, skip this step). Add near `setStatus` (~line 1797):

```ts
  /** Attach a task to a feature (pipeline expander backfills the root's feature). */
  setFeatureId(taskId: string, featureId: string): void {
    this.db
      .prepare('UPDATE tasks SET feature_id=@f, updated_at=@ts WHERE id=@id')
      .run({ id: taskId, f: featureId, ts: this.now() });
  }
```

- [ ] Create `src/main/__tests__/template-expander.test.ts` (mirrors the swarm test structure — real store, tmp db):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { expandTemplate, PIPELINE_EXPANDED_EVENT } from '../kanban/template-expander';
import { FULL_FEATURE, QUICK_FIX } from '../kanban/pipeline-templates';

const DIR = join(tmpdir(), `fleet-expander-test-${Date.now()}`);
const allRoles = { hasRole: () => true };

function store(): KanbanStore {
  return new KanbanStore(join(DIR, `e-${Math.random()}.db`), { now: () => 1000 });
}

function stageOf(s: KanbanStore, id: string): string | null {
  return s.getTask(id)?.pipelineStage ?? null;
}

describe('expandTemplate', () => {
  beforeEach(() => mkdirSync(DIR, { recursive: true }));
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it('lays down explore→spec→gate→qa with the gating links + a feature', () => {
    const s = store();
    const root = s.createTask({ title: 'Add billing', pipelineTemplate: 'full_feature' });
    expandTemplate(root, FULL_FEATURE, s, allRoles);

    const ev = s.listEvents(root.id).find((e) => e.kind === PIPELINE_EXPANDED_EVENT);
    expect(ev).toBeTruthy();
    const { exploreId, specId, gateId, qaId, featureId } = ev!.payload as Record<string, string>;

    expect(s.getFeature(featureId)).toBeTruthy();
    expect(stageOf(s, exploreId)).toBe('explore');
    expect(s.getTask(exploreId)?.status).toBe('ready');
    expect(stageOf(s, specId)).toBe('spec');
    expect(s.getTask(specId)?.status).toBe('todo');
    expect(stageOf(s, gateId)).toBe('gate');
    expect(s.getTask(gateId)?.status).toBe('blocked');
    expect(s.getTask(gateId)?.systemKind).toBe('pipeline_gate');
    expect(stageOf(s, qaId)).toBe('qa');

    // Links: explore→spec, spec→gate, gate→qa.
    expect(s.childrenOf(exploreId)).toContain(specId);
    expect(s.childrenOf(specId)).toContain(gateId);
    expect(s.childrenOf(gateId)).toContain(qaId);
    s.close();
  });

  it('is a no-op on re-run (idempotent)', () => {
    const s = store();
    const root = s.createTask({ title: 'X', pipelineTemplate: 'full_feature' });
    expandTemplate(root, FULL_FEATURE, s, allRoles);
    const before = s.listTasks().length;
    expandTemplate(s.getTask(root.id)!, FULL_FEATURE, s, allRoles);
    expect(s.listTasks().length).toBe(before);
    s.close();
  });

  it('falls back to quick_fix when a required role profile is missing', () => {
    const s = store();
    const root = s.createTask({ title: 'X', pipelineTemplate: 'full_feature' });
    expandTemplate(root, FULL_FEATURE, s, { hasRole: (r) => r !== 'qa' });
    // No stages created; only the fallback marker event.
    expect(s.listTasks().some((t) => t.pipelineStage !== null)).toBe(false);
    const ev = s.listEvents(root.id).find((e) => e.kind === PIPELINE_EXPANDED_EVENT);
    expect((ev!.payload as Record<string, unknown>).fallback).toBe('quick_fix');
    s.close();
  });

  it('does not expand quick_fix / inert template', () => {
    const s = store();
    const root = s.createTask({ title: 'X', pipelineTemplate: 'quick_fix' });
    expandTemplate(root, QUICK_FIX, s, allRoles);
    expect(s.listTasks().some((t) => t.pipelineStage !== null)).toBe(false);
    s.close();
  });
});
```

- [ ] Run: `npx vitest run src/main/__tests__/template-expander.test.ts` — expect 4 passing. Then `npm run typecheck` — expect green. (If `setFeatureId` already existed and you skipped adding it, confirm no duplicate-method TS error.)

- [ ] Commit:

```
feat(kanban): template-expander lays down full_feature stage graph
```

---

## Task 5 — Dispatcher decompose routing to the expander

**Files**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`decompose()` ~line 436; imports ~line 1-20; add a `hasRole`/profiles dep to `DispatcherDeps` ~line 124)
- Modify: `src/main/__tests__/kanban-dispatcher.test.ts` (add a describe block)
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

Context: `decompose()` iterates `store.pendingDecomposeTasks()` (triage tasks with a pending mode) and spawns an orchestrator run. A `full_feature` root should be routed to `expandTemplate` instead of spawning the orchestrator. The expander needs a `hasRole` predicate; add it as a dispatcher dep sourced from the profile list.

Steps:

- [ ] In `kanban-dispatcher.ts`, add imports at the top (after the existing `import { readLogTail } from './spawn-worker';`):

```ts
import { expandTemplate } from './template-expander';
import { getTemplate } from './pipeline-templates';
```

- [ ] In `kanban-dispatcher.ts`, add to `DispatcherDeps` (after `workerProfileNames?`):

```ts
  /** All profile role names present, for the pipeline expander's graceful-degradation check. */
  profileRoles?: () => string[];
```

- [ ] In `kanban-dispatcher.ts` `decompose()`, route full_feature roots to the expander before the orchestrator spawn. Replace the loop body's start (right after `if (!this.store.claimForDecompose(task.id, lock, ttl)) continue;`) — but the gate must be claimed first to avoid double work. Insert this BEFORE the `let runId` line, inside the `try`-free path:

```ts
    for (const task of this.store.pendingDecomposeTasks()) {
      if (slots <= 0) break;
      const mode = task.pendingMode;
      if (mode == null) continue;

      // Full-feature pipeline roots are expanded deterministically (no orchestrator).
      if (task.pipelineTemplate === 'full_feature') {
        const lock = this.nextLock();
        if (!this.store.claimForDecompose(task.id, lock, ttl)) continue;
        const roles = new Set(this.deps.profileRoles?.() ?? []);
        try {
          expandTemplate(task, getTemplate(task.pipelineTemplate), this.store, {
            hasRole: (r) => roles.has(r)
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.store.blockTask(task.id, `pipeline expansion failed: ${msg}`);
          log.error('pipeline expand failed', { taskId: task.id, error: msg });
        }
        slots -= 1;
        continue;
      }

      const lock = this.nextLock();
      if (!this.store.claimForDecompose(task.id, lock, ttl)) continue; // lost the race
      let runId: number | null = null;
      // ... (existing orchestrator spawn body unchanged)
```

(The existing `const mode = task.pendingMode; if (mode == null) continue;` and the following orchestrator body remain; only the full_feature branch and the lock-declaration move are new. Ensure `lock` is declared once per iteration — the original declared it after the `mode` check, so keep that single declaration for the orchestrator path and use a locally-scoped `lock` inside the pipeline `if` block as shown.)

- [ ] In `src/main/kanban/kanban-ipc.ts` (or wherever the dispatcher is constructed — search for `new KanbanDispatcher`), wire `profileRoles` from the settings profile list. Find the existing `workerProfileNames` dep and add alongside it:

```ts
      profileRoles: () => (getProfiles() ?? []).map((p) => p.role),
```

(Use the same profile-source function already used for `workerProfileNames` in that construction site; mirror its exact call.)

- [ ] Add a dispatcher test. Append to `src/main/__tests__/kanban-dispatcher.test.ts`:

```ts
describe('KanbanDispatcher.decompose pipeline routing', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('routes a full_feature triage root to the expander, not the orchestrator', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const root = store.createTask({
      title: 'Add billing',
      status: 'triage',
      pipelineTemplate: 'full_feature'
    });
    store.setPendingMode(root.id, 'decompose');
    let spawned = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => {
        spawned += 1;
        return 1;
      },
      profileRoles: () => ['explorer', 'architect', 'qa', 'worker'],
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      }
    });
    disp.decompose();
    expect(spawned).toBe(0); // expander runs in-process; no orchestrator spawn
    const stages = store.listTasks().map((t) => t.pipelineStage).filter(Boolean).sort();
    expect(stages).toEqual(['explore', 'gate', 'qa', 'spec']);
    store.close();
  });
});
```

- [ ] Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts` — expect green (existing + new). Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): route full_feature triage roots to the template expander
```

---

## Task 6 — Explore stage (prompt + read-only tools + spawn path)

**Files**
- Modify: `src/main/kanban/spawn-worker.ts` (`buildPrompt` ~line 81; `requireToolsForMode` ~line 186)
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`claimAndSpawn()` ~line 394; add a stage→mode helper)
- Modify/Create test: `src/main/__tests__/spawn-worker.test.ts` (check it exists; if not, create it)
- Test: `src/main/__tests__/spawn-worker.test.ts`

Context: `claimAndSpawn()` spawns every `readyTasks()` with `mode: 'work'`. A `pipeline_stage === 'explore'` ready task must spawn with `mode: 'explore'`. `buildPrompt` already takes `WorkerTaskInfo` (no `pipelineStage`); the dispatcher passes `mode` explicitly, so the prompt branch keys off `mode`.

Steps:

- [ ] In `spawn-worker.ts` `buildPrompt`, add an `explore` branch before the final `work` return (after the `review` branch, ~line 140):

```ts
  if (mode === 'explore') {
    return (
      `explore kanban task ${task.id}: ${task.title}\n\n${task.body}\n\n` +
      `You are a read-only cartographer. Map the codebase relevant to this task: affected ` +
      `files, modules, and patterns; surface risks and unknowns. Write NO code and make NO ` +
      `edits. Register your findings as a kanban_artifact (path relative to your working ` +
      `directory) and post a one-paragraph summary comment on this task with kanban_comment. ` +
      `When done, call kanban_complete with a one-line summary.`
    );
  }
```

- [ ] In `spawn-worker.ts` `requireToolsForMode`, add the `explore` case (terminal tool is `kanban_complete`/`kanban_block`, same family as work):

```ts
    case 'work':
    case 'decompose':
    case 'resolve':
    case 'explore':
      return 'kanban_complete,kanban_block';
```

- [ ] In `kanban-dispatcher.ts`, add a private helper to map a task's stage to its run mode, near `claimAndSpawn`:

```ts
  /** The run mode for a ready pipeline-stage task; non-pipeline ready tasks are plain 'work'. */
  private modeForReadyTask(task: Task): RunMode {
    if (task.pipelineStage === 'explore') return 'explore';
    if (task.pipelineStage === 'spec') return 'spec';
    if (task.pipelineStage === 'qa') return 'qa';
    return 'work';
  }
```

- [ ] In `kanban-dispatcher.ts` `claimAndSpawn()`, replace the hard-coded `mode: 'work'` in the `spawnWorker` call with the computed mode:

```ts
        const mode = this.modeForReadyTask(task);
        pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode });
```

(Keep the `clearReviewVerdict`/`resetReviewAttempts` calls — they are harmless for pipeline stages and reset on each fresh claim.)

- [ ] Add/extend a prompt-builder test. Check whether `src/main/__tests__/spawn-worker.test.ts` exists (`ls src/main/__tests__/`). If it exists, append; otherwise create it with this header importing the real `buildWorkerInvocation`/`buildPrompt`. Since `buildPrompt` is module-private, assert through the exported `buildWorkerInvocation`'s `args` (the `--prompt` value) and `--require-tool`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildWorkerInvocation } from '../kanban/spawn-worker';

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-spawn-'));
}
const baseTask = {
  id: 't1',
  title: 'Add billing',
  body: 'body',
  assignee: 'explorer',
  modelOverride: null
};

describe('buildWorkerInvocation explore mode', () => {
  it('emits a read-only mapping prompt and complete/block require-tool', () => {
    const inv = buildWorkerInvocation({
      task: baseTask,
      workspace: ws(),
      mcpPort: 1,
      runToken: 'tok',
      logPath: '/tmp/x.log',
      mode: 'explore'
    });
    const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
    expect(prompt).toContain('explore kanban task t1');
    expect(prompt).toContain('Write NO code');
    expect(prompt).toContain('kanban_artifact');
    expect(inv.args[inv.args.indexOf('--require-tool') + 1]).toBe('kanban_complete,kanban_block');
  });
});
```

- [ ] Run: `npx vitest run src/main/__tests__/spawn-worker.test.ts src/main/__tests__/kanban-dispatcher.test.ts` — expect green. Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): explore stage prompt, read-only tools, and spawn routing
```

---

## Task 7 — Spec stage + idempotent fan-out + auto-link (create path)

**Files**
- Modify: `src/main/kanban/spawn-worker.ts` (`buildPrompt` spec branch; `requireToolsForMode` spec case)
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`claimAndSpawn` spec is `work`-family? No — spec is its own mode; extend `modeForReadyTask`. But the spec task starts `todo`, promoted to `ready` after explore completes — so it flows through `claimAndSpawn`.)
- Modify: `src/main/kanban/kanban-mcp-server.ts` (worker-scope `kanban_create` handler ~line 1493: auto-wire links + idempotency + cap)
- Modify: `src/main/__tests__/kanban-mcp-server.test.ts`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

Context: when the architect (a `spec`-stage run) calls `kanban_create`, the handler must: set `pipelineStage='implement'` on the child, set the child's `featureId` to the root feature, `addLink(gateTask, child)` and `addLink(child, qaTask)`, enforce `MAX_FANOUT`, and record a `children_emitted` event on the spec task so a reclaim re-run does not double-fan-out. The handler resolves the gate/qa ids from the root's `pipeline_expanded` event (the spec task's feature → root → event). Empty-fan-out guard lives in `kanban_complete` (spec completed with zero children → block, no proposal — proposal creation is Task 8 in the dispatcher, which already won't fire on zero children).

Steps:

- [ ] In `spawn-worker.ts` `buildPrompt`, add a `spec` branch (after the `explore` branch):

```ts
  if (mode === 'spec') {
    return (
      `spec kanban task ${task.id}: ${task.title}\n\n${task.body}\n\n` +
      `You are the architect. Read the explore artifact and this task with kanban_show, then write ` +
      `a concrete implementation spec. Decompose the work into independent units: call kanban_create ` +
      `once per unit with a clear title and a body containing that unit's slice of the spec. Do NOT ` +
      `set parents, feature_id, or links — the system wires them. Cap your fan-out at ${MAX_FANOUT} ` +
      `children. Do not implement anything. When the fan-out is complete, call kanban_complete with a ` +
      `one-line plan summary.`
    );
  }
```

- [ ] Import `MAX_FANOUT` at the top of `spawn-worker.ts`:

```ts
import { MAX_FANOUT } from './pipeline-templates';
```

- [ ] In `spawn-worker.ts` `requireToolsForMode`, add the `spec` case (terminal tool `kanban_complete`/`kanban_block`):

```ts
    case 'work':
    case 'decompose':
    case 'resolve':
    case 'explore':
    case 'spec':
      return 'kanban_complete,kanban_block';
```

- [ ] In `kanban-store.ts`, add `pipelineAnchorForFeature` (near `getFeature`). It resolves the gate/qa ids from the root's `pipeline_expanded` event **keyed by feature** — NOT by walking parent links, because the expander does not link `root → explore` (explore is a standalone `ready` task, so a parent-walk from the spec would dead-end). The expander records `featureId` in the event payload (Task 4); query it with `json_extract`. Match the file's existing row-cast idiom (`as Record<string, unknown>` / typed-row casts are used throughout this store) and validate the extracted ids with `typeof` at runtime:

```ts
  /**
   * Resolve a full_feature pipeline's gate/qa task ids from the root's pipeline_expanded
   * event, keyed by feature id. Returns null for non-pipeline features or fallback
   * expansions (which record `fallback` and no stage ids).
   */
  pipelineAnchorForFeature(
    featureId: string
  ): { gateId: string; qaId: string; featureId: string } | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM task_events WHERE kind='pipeline_expanded' " +
          "AND json_extract(payload, '$.featureId')=@f " +
          "AND json_extract(payload, '$.fallback') IS NULL LIMIT 1"
      )
      .get({ f: featureId }) as { payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    const gateId = p.gateId;
    const qaId = p.qaId;
    if (typeof gateId !== 'string' || typeof qaId !== 'string') return null;
    return { gateId, qaId, featureId };
  }
```

(Verify `appendEvent` stores `payload` as a JSON string — it does; `json_extract` requires it. better-sqlite3 ships SQLite with JSON1 enabled.)

- [ ] In `kanban-mcp-server.ts`, the worker-scope `kanban_create` handler (~line 1493) must auto-wire children when the calling task is a spec stage. Add a private helper on the server class that delegates to the feature-keyed store lookup. Place it near the other private helpers:

```ts
  /** For a spec-stage task, resolve the pipeline gate/qa task ids (feature-keyed; no parent walk). */
  private pipelineAnchor(specTask: Task): { gateId: string; qaId: string; featureId: string } | null {
    if (specTask.pipelineStage !== 'spec' || !specTask.featureId) return null;
    return this.store.pipelineAnchorForFeature(specTask.featureId);
  }
```

- [ ] In the worker-scope `kanban_create` handler, after parsing `a` and the assignee guard but before `const inherit = this.inheritWorkspace(task);`, insert the spec-stage branch (so a spec run gets the deterministic wiring + cap + idempotency, and other modes keep today's behavior):

```ts
          const anchor = this.pipelineAnchor(task);
          if (anchor) {
            // Idempotency keyed on the RUN, not on existence of children. The first child a
            // run creates stamps `children_emitted` with that runId. A reclaim re-run is a
            // DIFFERENT run: if a children_emitted event from another run exists, this run's
            // fan-out is a duplicate — reject it so the prior children stand. Within the same
            // run, subsequent kanban_create calls share the runId and are allowed. (Dismiss
            // re-arm deletes the event via clearSpecFanout, so a re-armed run fans out fresh.)
            const emittedEvents = this.store
              .listEvents(task.id)
              .filter((e) => e.kind === 'children_emitted');
            const priorRun = emittedEvents.find((e) => e.payload?.runId !== scope.runId);
            if (priorRun) {
              return this.rpcError(
                res,
                rpcReq.id,
                'children already emitted by a prior run; call kanban_complete'
              );
            }
            const existing = this.store
              .childrenOf(task.id)
              .filter((id) => this.store.getTask(id)?.pipelineStage === 'implement').length;
            if (existing >= MAX_FANOUT) {
              return this.rpcError(
                res,
                rpcReq.id,
                `fan-out cap reached (${MAX_FANOUT}); stop creating children and call kanban_complete`
              );
            }
            const child = this.store.createTask({
              title: a.title,
              body: a.body ?? '',
              assignee,
              priority: a.priority ?? 0,
              status: 'todo',
              boardId: task.boardId,
              featureId: anchor.featureId,
              pipelineStage: 'implement',
              ...this.inheritWorkspace(task)
            });
            this.store.addLink(anchor.gateId, child.id); // held until approval
            this.store.addLink(child.id, anchor.qaId); // QA waits for it
            this.store.appendEvent(child.id, scope.runId, 'task_created', {
              by: 'architect',
              parent: task.id
            });
            if (emittedEvents.length === 0) {
              this.store.appendEvent(task.id, scope.runId, 'children_emitted', {
                runId: scope.runId
              });
            }
            return this.text(res, rpcReq.id, child.id);
          }
```

(Note: `pipeline_expanded` payload uses `featureId` so the `inheritWorkspace(task)` for a spec task whose feature has a repo will produce a worktree child — the desired implement behavior. Confirm `inheritWorkspace` returns repo/baseBranch from the task; the spec task carries the feature's repo via `common` in Task 4.)

- [ ] Add MCP-server tests. Append to `src/main/__tests__/kanban-mcp-server.test.ts` (cast scope/handler helpers in tests are allowed). Use the file's existing test harness for invoking a worker-scope `kanban_create`; assert topology + idempotency + cap. Pattern (adapt to the file's actual `callTool`/scope helper names):

```ts
describe('kanban_create spec-stage auto-link', () => {
  it('wires implement children to gate + qa and is idempotent + capped', () => {
    // Arrange: build a full_feature graph (root → explore → spec → gate → qa) via expandTemplate,
    // then drive kanban_create as the spec run.
    // (Use the suite's existing makeServer()/store helpers; seed explorer/architect/qa roles.)
    // Assert each created child has pipelineStage 'implement', parent gateId, child link → qaId.
    // Assert a re-run with children_emitted present creates no duplicate (single children_emitted event).
    // Assert creating a 13th child returns an rpcError mentioning the cap.
  });
});
```

(IMPORTANT for the implementer: open `src/main/__tests__/kanban-mcp-server.test.ts`, copy the nearest existing worker-scope tool-call test's setup verbatim — how it constructs the server, registers a run/scope, and calls the tool — then fill the asserts above with real ids from the `pipeline_expanded` event. Do not invent helper names.)

- [ ] Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts` — expect green. Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): spec-stage fan-out auto-links children to gate + qa (idempotent, capped)
```

---

## Task 8 — approve_spec proposal creation (dispatcher, PM-independent)

**Files**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (new private `raiseSpecApprovals()` + a call in `tick()` ~line 1159; empty-fan-out guard)
- Modify: `src/main/__tests__/kanban-dispatcher.test.ts`
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

Context: when a `spec`-stage task reaches `done` with ≥1 implement child, the dispatcher (not a PM turn) creates an `approve_spec` proposal targeting the gate task. With zero children, the spec is blocked and NO proposal is raised. Idempotency: only raise once per spec task (guard on an event or on an existing pending/resolved proposal for the gate).

Steps:

- [ ] In `kanban-dispatcher.ts`, add a private method (place near `integrateFeatures`):

```ts
  /**
   * For each freshly-done spec stage: with ≥1 implement child, create an approve_spec
   * proposal targeting the gate task (PM-agent-independent — created at the store level).
   * With zero children, block the spec ("architect produced no implementation tasks") and
   * raise NO proposal. Idempotent via a one-shot 'spec_approval_raised' event.
   */
  private raiseSpecApprovals(): void {
    for (const spec of this.store.doneSpecTasks()) {
      if (this.store.listEvents(spec.id).some((e) => e.kind === 'spec_approval_raised')) continue;
      const children = this.store
        .childrenOf(spec.id) // spec → gate; find implement children via the gate's children
        .flatMap((gateId) => this.store.childrenOf(gateId))
        .filter((id) => this.store.getTask(id)?.pipelineStage === 'implement');
      const gateId = this.store.childrenOf(spec.id).find((id) => this.store.getTask(id)?.pipelineStage === 'gate');
      if (!gateId) continue;
      if (children.length === 0) {
        this.store.blockTask(spec.id, 'architect produced no implementation tasks');
        this.store.appendEvent(spec.id, null, 'spec_approval_raised', { empty: true });
        continue;
      }
      const rationale =
        `Architect plan: ${spec.result ?? spec.title}. ` +
        `${children.length} implementation task(s). Review explore findings before approving.`;
      this.store.createProposal({
        boardId: spec.boardId,
        kind: 'approve_spec',
        targetId: gateId,
        rationale
      });
      this.store.appendEvent(spec.id, null, 'spec_approval_raised', { gateId, children: children.length });
    }
  }
```

- [ ] In `kanban-store.ts`, add `doneSpecTasks()` (near `reviewPendingTasks`):

```ts
  /** Spec-stage tasks that have completed (status done), for approval-proposal raising. */
  doneSpecTasks(): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE pipeline_stage='spec' AND status='done'")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }
```

- [ ] In `kanban-dispatcher.ts` `tick()`, add the call after `this.reviewTasks();`:

```ts
    this.reviewTasks();
    this.raiseSpecApprovals();
    this.integrate();
```

- [ ] Add a test. Append to `src/main/__tests__/kanban-dispatcher.test.ts`:

```ts
describe('KanbanDispatcher.raiseSpecApprovals', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('creates an approve_spec proposal when a done spec has children (autopilot OFF)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    const spec = store.createTask({ title: 'Spec', status: 'done', pipelineStage: 'spec', featureId: f.id, result: 'plan summary' });
    const gate = store.createTask({ title: 'Gate', status: 'blocked', pipelineStage: 'gate', systemKind: 'pipeline_gate', featureId: f.id });
    const child = store.createTask({ title: 'impl', status: 'todo', pipelineStage: 'implement', featureId: f.id });
    store.addLink(spec.id, gate.id);
    store.addLink(gate.id, child.id);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t, isAlive: () => true, spawnWorker: () => undefined,
      config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000, autoDecompose: false, autoAssign: false, autoIntegrate: false, autoReview: false, maxDecompose: 1, artifactRetentionDays: 0 }
    });
    disp['raiseSpecApprovals']();
    const props = store.listProposals('default', { status: 'pending' });
    expect(props.map((p) => p.kind)).toContain('approve_spec');
    expect(props.find((p) => p.kind === 'approve_spec')?.targetId).toBe(gate.id);
    store.close();
  });

  it('blocks the spec and raises no proposal on empty fan-out', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    const spec = store.createTask({ title: 'Spec', status: 'done', pipelineStage: 'spec', featureId: f.id });
    const gate = store.createTask({ title: 'Gate', status: 'blocked', pipelineStage: 'gate', systemKind: 'pipeline_gate', featureId: f.id });
    store.addLink(spec.id, gate.id);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t, isAlive: () => true, spawnWorker: () => undefined,
      config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000, autoDecompose: false, autoAssign: false, autoIntegrate: false, autoReview: false, maxDecompose: 1, artifactRetentionDays: 0 }
    });
    disp['raiseSpecApprovals']();
    expect(store.getTask(spec.id)?.status).toBe('blocked');
    expect(store.listProposals('default', { status: 'pending' })).toHaveLength(0);
    store.close();
  });
});
```

- [ ] Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts` — expect green. Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): dispatcher raises approve_spec proposal on non-empty spec completion
```

---

## Task 9 — proposal-executor approve_spec + dismiss re-arm

**Files**
- Modify: `src/main/kanban/proposal-executor.ts` (add `approve_spec` case ~line 18)
- Modify: `src/main/kanban/kanban-commands.ts` (`dismissProposal` ~line 1101: re-arm spec on `approve_spec` dismiss; add `approveSpec` helper)
- Modify: `src/main/__tests__/kanban-commands.test.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts`

Context: `executeProposal` is `switch (kind)` and calls `KanbanCommands` methods. Approve marks the gate task `done` (releasing implement children via `promotableTodoTasks`). Dismiss (handled in `dismissProposal`) re-arms the spec stage: reset its status to `ready` with the dismissal comment as guidance and clear the `children_emitted` guard so the new run may re-fan-out.

Steps:

- [ ] In `kanban-commands.ts`, add an `approveSpec` method (near `acceptReviewTask`):

```ts
  /** Release a pipeline approval gate: mark the gate task done so its implement children promote. */
  approveSpec(gateTaskId: string): KanbanReviewActionResult {
    const gate = this.store.getTask(gateTaskId);
    if (!gate) return { ok: false, error: 'gate task not found' };
    if (gate.pipelineStage !== 'gate') return { ok: false, error: 'target is not a pipeline gate' };
    this.store.setStatus(gateTaskId, 'done');
    this.store.appendEvent(gateTaskId, null, 'spec_approved', {});
    return { ok: true };
  }
```

(Confirm `setStatus` does not clear/touch `result` in a way that breaks the gate — `setStatus` at ~line 1797 only updates status + updated_at. A `blocked`→`done` transition is fine; `promotableTodoTasks` treats `done` as settled.)

- [ ] In `proposal-executor.ts`, add the `approve_spec` case to the switch (before the `default`):

```ts
    case 'approve_spec':
      expectOk(commands.approveSpec(targetId));
      return;
```

- [ ] In `kanban-commands.ts` `dismissProposal`, re-arm the spec when an `approve_spec` proposal is dismissed. Replace the method body:

```ts
  dismissProposal(id: string): void {
    const p = this.store.getProposal(id);
    if (!p) throw new CodedError('proposal not found', 'NOT_FOUND');
    if (p.status !== 'pending') return; // already resolved — dismiss is a no-op
    this.store.resolveProposal(id, 'dismissed', null);
    if (p.kind === 'approve_spec') {
      // Re-arm the spec stage. p.targetId is the gate task. First archive the prior
      // fan-out's implement children (linked gate→child) so the re-armed architect run
      // starts clean instead of piling a second set on top. Archived children count as
      // settled, so they don't gate QA. (Don't touch the gate→qa link target.)
      for (const childId of this.store.childrenOf(p.targetId)) {
        if (this.store.getTask(childId)?.pipelineStage === 'implement') {
          this.store.setStatus(childId, 'archived');
        }
      }
      // Find the spec via the gate (gate's only parent is the spec), inject the dismissal
      // as guidance, reset to ready, and clear the fan-out guard so it may re-fan-out.
      const specId = this.store.parentsOf(p.targetId).find(
        (pid) => this.store.getTask(pid)?.pipelineStage === 'spec'
      );
      if (specId) {
        this.store.addComment(specId, 'pm', `Spec dismissed: revise and re-fan-out. ${p.rationale}`);
        this.store.clearSpecFanout(specId);
        this.store.setStatus(specId, 'ready');
      }
    }
  }
```

- [ ] In `kanban-store.ts`, add `clearSpecFanout` (deletes the `children_emitted` event so a re-run may re-fan-out). Add near `appendEvent`:

```ts
  /** Drop a spec task's children_emitted guard so a re-armed run may re-fan-out (pipeline §6). */
  clearSpecFanout(specTaskId: string): void {
    this.db
      .prepare("DELETE FROM task_events WHERE task_id=? AND kind='children_emitted'")
      .run(specTaskId);
  }
```

- [ ] Add tests. Append to `src/main/__tests__/kanban-commands.test.ts` (it uses the real store + commands; mirror its existing setup):

```ts
describe('approve_spec proposal', () => {
  it('approve marks the gate done so children can promote; before approve they cannot', () => {
    // Build feature + spec(done) → gate(blocked) → implement child(todo) with proper links.
    // Assert promotableTodoTasks() does NOT include the child while gate is blocked.
    // proposeAction('approve_spec', gateId) then approveProposal(); assert gate is 'done'
    // and the child now appears in promotableTodoTasks().
  });

  it('dismiss re-arms the spec (ready), archives prior children, clears the guard', () => {
    // Seed spec(blocked-on)→gate→implement child + a children_emitted event on the spec;
    // create + dismiss the approve_spec proposal (targetId = gate). Assert: spec status is
    // 'ready', a 'Spec dismissed' comment exists, no children_emitted event remains, and the
    // prior implement child is now 'archived'.
  });
});
```

(Implementer: open `src/main/__tests__/kanban-commands.test.ts`, copy the nearest proposal test's store/commands construction, and fill the asserts with real ids. `promotableTodoTasks` lives on the store.)

- [ ] Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts` — expect green. Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): approve_spec executor + dismiss re-arms the spec stage
```

---

## Task 10 — QA stage (prompt + tools + verdict path + spawn)

**Files**
- Modify: `src/main/kanban/spawn-worker.ts` (`buildPrompt` qa branch; `requireToolsForMode` qa case)
- Modify: `src/main/kanban/kanban-mcp-server.ts` (new `kanban_qa_verdict` tool: worker-tool list + handler; `toolsForMode` includes it for `qa`)
- Modify: `src/main/__tests__/spawn-worker.test.ts`, `src/main/__tests__/kanban-mcp-server.test.ts`
- Test: those two files

Context: the qa task is created `todo` (Task 4), promoted to `ready` after the gate + all implement children settle, and spawned with `mode: 'qa'` (Task 6's `modeForReadyTask` already returns `'qa'`). QA records the verdict on the feature via a new MCP tool `kanban_qa_verdict` (decision `pass|request_changes`, summary). The tool sets `features.qa_verdict` and is the qa run's terminal tool.

Steps:

- [ ] In `spawn-worker.ts` `buildPrompt`, add a `qa` branch (after `spec`):

```ts
  if (mode === 'qa') {
    return (
      `qa kanban task ${task.id}: ${task.title}\n\n${task.body}\n\n` +
      `You are QA for this feature. Validate the whole feature against the root task's acceptance ` +
      `criteria. Run the project's verify commands and exercise end-to-end behavior (execution-based, ` +
      `not a re-read of diffs). Re-check the risks the explore stage flagged. When done, call ` +
      `kanban_qa_verdict with decision 'pass' or 'request_changes' and a one-line summary.`
    );
  }
```

- [ ] In `spawn-worker.ts` `requireToolsForMode`, add the `qa` case:

```ts
    case 'qa':
      return 'kanban_qa_verdict';
```

- [ ] In `kanban-mcp-server.ts`, register `kanban_qa_verdict`. Add the tool descriptor near `kanban_review_verdict` in the worker tool list and include it in `toolsForMode` for `'qa'`:

```ts
  {
    name: 'kanban_qa_verdict',
    description:
      "Record the feature-level QA verdict. decision 'pass' lets the feature PR become ready; " +
      "'request_changes' bounces the implement tasks for a fix.",
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['pass', 'request_changes'] },
        summary: { type: 'string' }
      },
      required: ['decision', 'summary']
    }
  },
```

(Find the function that maps a `RunMode` to its allowed tools — `toolsForMode` — and ensure mode `'qa'` returns a list containing `kanban_show`, `kanban_comment`, `kanban_heartbeat`, `kanban_artifact`, and `kanban_qa_verdict`. Mirror how `'review'` maps to `kanban_review_verdict`.)

- [ ] In `kanban-mcp-server.ts`, add the handler case in the worker-scope switch (near `kanban_review_verdict`):

```ts
        case 'kanban_qa_verdict': {
          const a = z
            .object({
              decision: z.enum(['pass', 'request_changes']),
              summary: z.string().min(1)
            })
            .parse(args);
          if (scope.runId !== task.currentRunId || task.status !== 'running') {
            this.unregisterRun(token);
            return this.text(res, rpcReq.id, `Verdict ignored: task ${task.id} moved on.`);
          }
          if (!task.featureId) {
            return this.rpcError(res, rpcReq.id, 'qa task has no feature');
          }
          this.store.setQaVerdict(task.featureId, a.decision);
          this.store.addComment(task.id, 'qa', `qa ${a.decision}: ${a.summary}`);
          this.store.appendEvent(
            task.id,
            scope.runId,
            a.decision === 'pass' ? 'qa_passed' : 'qa_changes_requested',
            { summary: a.summary }
          );
          // 'pass' completes the qa task (it satisfies the rollup); 'request_changes'
          // leaves re-arming to the dispatcher (Task 11).
          if (a.decision === 'pass') {
            this.store.completeTask(task.id, `QA pass: ${a.summary}`);
          }
          this.store.finishRun(scope.runId, 'completed', { summary: a.summary });
          this.unregisterRun(token);
          return this.text(res, rpcReq.id, `QA verdict recorded for feature ${task.featureId}.`);
        }
```

- [ ] Add prompt + verdict tests. In `src/main/__tests__/spawn-worker.test.ts` append a qa prompt assertion (mirror Task 6's explore test, asserting `qa kanban task`, `Run the project's verify commands`, and `--require-tool` === `kanban_qa_verdict`). In `src/main/__tests__/kanban-mcp-server.test.ts`, append a test driving a `qa`-scope run calling `kanban_qa_verdict` with `pass` and asserting `store.getFeature(fid)?.qaVerdict === 'pass'` and the qa task is `done` (copy the nearest verdict-tool test's setup).

- [ ] Run: `npx vitest run src/main/__tests__/spawn-worker.test.ts src/main/__tests__/kanban-mcp-server.test.ts` — expect green. Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): qa stage prompt, kanban_qa_verdict tool, feature verdict
```

---

## Task 11 — QA gates PR-ready + request_changes re-arm

**Files**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`markFeaturePrReady` ~line 990: add qa_verdict guard; new `processQaChanges()` + `tick()` call; import `QA_ATTEMPT_CAP`)
- Modify: `src/main/__tests__/kanban-dispatcher.test.ts`
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

Context: a pipeline feature (`qaVerdict !== null` OR has a qa-stage task) must not flip its PR to ready until `qaVerdict === 'pass'`. On `request_changes`, re-arm the implement children for a fix run, bounded by `QA_ATTEMPT_CAP` cycles tracked via a `qa_attempt` event count on the feature's qa task; on cap exhaustion mark the feature blocked + notify.

Steps:

- [ ] In `kanban-dispatcher.ts`, import the cap at the top:

```ts
import { getTemplate, MAX_FANOUT, QA_ATTEMPT_CAP } from './pipeline-templates';
```

(Adjust the existing import line from Task 5 to include `QA_ATTEMPT_CAP`; `MAX_FANOUT` only if used here — if not, omit it.)

- [ ] In `kanban-dispatcher.ts` `markFeaturePrReady`, add the QA guard at the top of the method (after the existing early return):

```ts
  private markFeaturePrReady(feature: Feature): void {
    if (feature.prState !== 'draft' || feature.prNumber == null || !feature.repoPath) return;
    // Pipeline features gate PR-ready on a passing QA verdict. A feature that has been
    // QA'd (verdict non-null) but not passed must wait; non-pipeline features (verdict
    // null AND no qa task) are unaffected.
    if (feature.qaVerdict !== null && feature.qaVerdict !== 'pass') return;
    if (feature.qaVerdict === null && this.store.featureHasQaStage(feature.id)) return;
    // ... existing markPrReady body unchanged
```

- [ ] In `kanban-store.ts`, add `featureHasQaStage`:

```ts
  /** True when a feature has a qa-stage task (it is a pipeline feature awaiting QA). */
  featureHasQaStage(featureId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM tasks WHERE feature_id=? AND pipeline_stage='qa' LIMIT 1")
      .get(featureId);
    return row != null;
  }
```

- [ ] In `kanban-dispatcher.ts`, add `processQaChanges()` (near `raiseSpecApprovals`):

```ts
  /**
   * Handle QA request_changes: re-arm the feature's implement children for a fix run, once
   * per qa_changes_requested event, bounded by QA_ATTEMPT_CAP. On cap exhaustion mark the
   * feature blocked and emit a 'blocked' event (the #233 autopilot trigger surfaces it).
   */
  private processQaChanges(): void {
    for (const qa of this.store.qaTasksNeedingRearm()) {
      if (!qa.featureId) continue;
      const attempts = this.store.listEvents(qa.id).filter((e) => e.kind === 'qa_rearmed').length;
      if (attempts >= QA_ATTEMPT_CAP) {
        this.store.updateFeature(qa.featureId, { status: 'active' }); // keep active; block the qa task
        this.store.blockTask(qa.id, `QA still failing after ${QA_ATTEMPT_CAP} attempt(s)`);
        this.store.appendEvent(qa.id, null, 'blocked', { reason: 'qa_attempt_cap' });
        continue;
      }
      // Re-arm implement children: set them back to ready with the QA findings as guidance.
      for (const childId of this.store.implementChildrenOf(qa.id)) {
        this.store.setStatus(childId, 'ready');
      }
      this.store.setQaVerdict(qa.featureId, null); // clear so the next QA run can re-verdict
      this.store.setStatus(qa.id, 'todo'); // qa re-gates on the children again
      this.store.appendEvent(qa.id, null, 'qa_rearmed', { attempt: attempts + 1 });
    }
  }
```

- [ ] In `kanban-store.ts`, add the two helpers:

```ts
  /** qa-stage tasks whose feature verdict is request_changes and which haven't been re-armed for it yet. */
  qaTasksNeedingRearm(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t JOIN features f ON f.id = t.feature_id
          WHERE t.pipeline_stage='qa' AND f.qa_verdict='request_changes'`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** Implement-stage tasks linked as parents of a qa task (the children QA waits on). */
  implementChildrenOf(qaTaskId: string): string[] {
    return this.parentsOf(qaTaskId).filter(
      (id) => this.getTask(id)?.pipelineStage === 'implement'
    );
  }
```

- [ ] In `kanban-dispatcher.ts` `tick()`, add the call after `raiseSpecApprovals`:

```ts
    this.raiseSpecApprovals();
    this.processQaChanges();
    this.integrate();
```

- [ ] Add tests. Append to `src/main/__tests__/kanban-dispatcher.test.ts`:

```ts
describe('KanbanDispatcher QA gating', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  function disp(store: KanbanStore, clock: { t: number }, ops?: Partial<IntegrationOps>): KanbanDispatcher {
    return new KanbanDispatcher(store, {
      now: () => clock.t, isAlive: () => true, spawnWorker: () => undefined,
      integration: { ...({} as IntegrationOps), ...ops },
      config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000, autoDecompose: false, autoAssign: false, autoIntegrate: true, autoReview: false, maxDecompose: 1, artifactRetentionDays: 0 }
    });
  }

  it('request_changes re-arms implement children, then blocks the qa task at the cap', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    const qa = store.createTask({ title: 'QA', status: 'todo', pipelineStage: 'qa', featureId: f.id });
    const child = store.createTask({ title: 'impl', status: 'done', pipelineStage: 'implement', featureId: f.id });
    store.addLink(child.id, qa.id);
    store.setQaVerdict(f.id, 'request_changes');
    const d = disp(store, clock);

    d['processQaChanges'](); // attempt 1
    expect(store.getTask(child.id)?.status).toBe('ready');
    expect(store.getFeature(f.id)?.qaVerdict).toBeNull();

    store.setQaVerdict(f.id, 'request_changes');
    d['processQaChanges'](); // attempt 2 (== cap)
    store.setQaVerdict(f.id, 'request_changes');
    d['processQaChanges'](); // cap exhausted -> block
    expect(store.getTask(qa.id)?.status).toBe('blocked');
    store.close();
  });
});
```

(Note: `markFeaturePrReady` is private and exercised via `integrate()`; a focused unit test for the verdict guard can call `disp['markFeaturePrReady'](feature)` after seeding a draft PR feature with `qaVerdict='request_changes'` and asserting `setFeaturePrState` was never reached — but since `markPrReady` is injected via `ops`, assert the injected `markPrReady` spy was NOT called. Add that as a second `it` using a `markPrReady: () => { called = true; return { ok: true }; }` op.)

- [ ] Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts` — expect green. Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): QA gates PR-ready; request_changes re-arms within QA_ATTEMPT_CAP
```

---

## Task 12 — sweepStalePipelines liveness sweep

**Files**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (new `sweepStalePipelines()` + `tick()` call; threshold constant)
- Modify: `src/main/__tests__/kanban-dispatcher.test.ts`
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

Context: flag a pipeline whose current stage has been idle past a threshold (gate never approved, QA looping, dead stage) → mark the feature blocked + emit a `blocked` event. Idle = the feature's most-recently-updated pipeline task hasn't changed in `PIPELINE_STALE_MS`, and no pipeline task is `running`/`ready`.

Steps:

- [ ] In `kanban-dispatcher.ts`, add the threshold constant near the other caps (~line 58):

```ts
/** A pipeline whose current stage is idle longer than this is flagged stale (spec §12). */
const PIPELINE_STALE_MS = 24 * 60 * 60 * 1000;
```

- [ ] In `kanban-dispatcher.ts`, add the sweep (near `sweepArtifacts`):

```ts
  /**
   * Flag pipelines stalled at their current stage past PIPELINE_STALE_MS (gate never
   * approved, QA looping, dead stage). Marks the feature blocked + emits a 'blocked'
   * event so the #233 autopilot trigger surfaces it. Fire-once per feature.
   */
  sweepStalePipelines(): void {
    const cutoff = this.deps.now() - PIPELINE_STALE_MS;
    for (const f of this.store.activePipelineFeatures()) {
      const tasks = this.store.pipelineTasksForFeature(f.id);
      if (tasks.length === 0) continue;
      const live = tasks.some((t) => t.status === 'running' || t.status === 'ready');
      if (live) continue;
      const settled = tasks.every((t) => t.status === 'done' || t.status === 'archived');
      if (settled) continue; // pipeline finished, not stalled
      const lastUpdate = Math.max(...tasks.map((t) => t.updatedAt));
      if (lastUpdate > cutoff) continue; // still within the idle window
      this.store.updateFeature(f.id, { status: 'active' });
      this.store.appendEvent(f.id, null, 'blocked', { reason: 'pipeline_stalled' });
    }
  }
```

- [ ] In `kanban-store.ts`, add the two helpers:

```ts
  /** Active features that have at least one pipeline-stage task. */
  activePipelineFeatures(): Feature[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT f.* FROM features f JOIN tasks t ON t.feature_id = f.id
          WHERE f.status='active' AND t.pipeline_stage IS NOT NULL`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToFeature(r));
  }

  /** All pipeline-stage tasks for a feature. */
  pipelineTasksForFeature(featureId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE feature_id=? AND pipeline_stage IS NOT NULL')
      .all(featureId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }
```

- [ ] In `kanban-dispatcher.ts` `tick()`, add the call after `sweepMergedWorktrees()`:

```ts
    this.sweepMergedWorktrees();
    this.sweepStalePipelines();
```

- [ ] Add a test. Append to `src/main/__tests__/kanban-dispatcher.test.ts`:

```ts
describe('KanbanDispatcher.sweepStalePipelines', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('flags an idle-past-threshold pipeline as blocked + emits the event', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    // A blocked gate (not running/ready, not settled), last updated at t=1000.
    store.createTask({ title: 'Gate', status: 'blocked', pipelineStage: 'gate', systemKind: 'pipeline_gate', featureId: f.id });
    clock.t = 1000 + 25 * 60 * 60 * 1000; // 25h later, past the 24h threshold
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t, isAlive: () => true, spawnWorker: () => undefined,
      config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000, autoDecompose: false, autoAssign: false, autoIntegrate: false, autoReview: false, maxDecompose: 1, artifactRetentionDays: 0 }
    });
    disp.sweepStalePipelines();
    expect(store.listEvents(f.id).some((e) => e.kind === 'blocked' && e.payload?.reason === 'pipeline_stalled')).toBe(true);
    store.close();
  });
});
```

- [ ] Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts` — expect green. Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): sweepStalePipelines flags idle pipelines as blocked
```

---

## Task 13 — Default profiles seed (explorer, architect, reviewer, qa)

**Files**
- Modify: `src/shared/constants.ts` (`profiles` array ~line 126)
- Modify/Create test: `src/main/__tests__/constants.test.ts` (check if it exists; if not, create a small one)
- Test: that file

Context: today only `default` (worker) and `orchestrator` are seeded. Add `explorer`, `architect`, `reviewer`, `qa` with personas from spec §9. The reviewer is distinct from worker and may set a different model (leave `model: ''` to inherit, but the instructions note it should differ — keep it minimal and within style).

Steps:

- [ ] In `src/shared/constants.ts`, append to the `profiles` array (after the `orchestrator` entry, before the closing `]`):

```ts
      {
        name: 'explorer',
        role: 'explorer',
        model: '',
        skills: [],
        instructions:
          'You are a read-only cartographer. Map the files, modules, and patterns affected by the ' +
          'task; surface risks and unknowns. Never write code. Register your findings as a ' +
          'kanban_artifact and post a one-paragraph summary on the root task, then call kanban_complete.'
      },
      {
        name: 'architect',
        role: 'architect',
        model: '',
        skills: [],
        instructions:
          'You are the architect. Consume the explore findings, write a concrete implementation spec, ' +
          'then emit the implementation work by calling kanban_create once per unit (capped). Do not ' +
          'implement anything yourself. Call kanban_complete with a plan summary when the fan-out is done.'
      },
      {
        name: 'reviewer',
        role: 'reviewer',
        model: '',
        skills: ['requesting-code-review'],
        instructions:
          'You are an independent code reviewer, distinct from the implementer (prefer a different model ' +
          'to counter self-preference bias). Judge the diff against the task goal and acceptance criteria; ' +
          'call kanban_review_verdict with approve or request_changes plus specific findings.'
      },
      {
        name: 'qa',
        role: 'qa',
        model: '',
        skills: [],
        instructions:
          'You are feature-level QA. Validate the whole feature against acceptance criteria using ' +
          'execution (run the project verify commands and exercise behavior), not a re-read of diffs. ' +
          'Emit your verdict with kanban_qa_verdict: pass or request_changes.'
      }
```

- [ ] Add a test. Check `ls src/main/__tests__/` and `src/shared/__tests__/` for an existing constants test. If none, create `src/main/__tests__/default-profiles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/constants';

describe('DEFAULT_SETTINGS.kanban.profiles', () => {
  it('seeds all six SDLC roles', () => {
    const byName = new Map(DEFAULT_SETTINGS.kanban.profiles.map((p) => [p.name, p.role]));
    expect(byName.get('default')).toBe('worker');
    expect(byName.get('orchestrator')).toBe('orchestrator');
    expect(byName.get('explorer')).toBe('explorer');
    expect(byName.get('architect')).toBe('architect');
    expect(byName.get('reviewer')).toBe('reviewer');
    expect(byName.get('qa')).toBe('qa');
    expect(DEFAULT_SETTINGS.kanban.profiles).toHaveLength(6);
  });
});
```

- [ ] Run: `npx vitest run src/main/__tests__/default-profiles.test.ts` — expect green. Then `npm run typecheck` — expect green (the new roles already valid after Task 2).

- [ ] Commit:

```
feat(kanban): seed explorer, architect, reviewer, qa default profiles
```

---

## Task 14 — Intake: pipeline_template arg (MCP + commands + IPC + preload)

**Files**
- Modify: `src/main/kanban/kanban-mcp-server.ts` (PM-scope `kanban_create` schema ~line 826 + the `commands.create({...})` call ~line 905; tool descriptor ~line 150 for the worker list is NOT needed — intake is the PM/board scope)
- Modify: `src/main/kanban/kanban-commands.ts` (`create` ~line 94 already spreads `input`; verify `pipelineTemplate` flows through — it does via the spread)
- Modify: `src/main/kanban/kanban-ipc.ts` (`KANBAN_CREATE_TASK` handler ~line 59 already passes `CreateTaskInput` through — verify)
- Modify: `src/preload/index.ts` (`createTask` ~line 544 already passes `CreateTaskInput` — verify the type includes the new field after Task 2)
- Modify: `src/main/__tests__/kanban-mcp-server.test.ts`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

Steps:

- [ ] In `kanban-mcp-server.ts` PM-scope `kanban_create` zod schema (~line 826), add the optional enum:

```ts
              docs: z.array(z.string()).optional(),
              pipeline_template: z.enum(['full_feature', 'quick_fix']).optional()
            })
            .parse(args);
```

- [ ] In the same PM-scope handler, pass it into `commands.create({...})` (~line 905) — add `pipelineTemplate`:

```ts
          const task = commands.create({
            title: a.title,
            body: a.body ?? '',
            assignee,
            priority: a.priority ?? 0,
            status: a.status ?? 'todo',
            boardId: scope.boardId,
            featureId: a.feature_id ?? null,
            docs: a.docs ?? [],
            pipelineTemplate: a.pipeline_template ?? null,
            ...workspace
          });
```

(Confirm the existing trailing fields/spread; insert `pipelineTemplate` alongside them without reordering the others.)

- [ ] In the PM `kanban_create` tool DESCRIPTOR (the board/PM tool definition — find the one with `status` enum and `project`/`docs` properties, distinct from the worker descriptor at line 150), add to `properties`:

```ts
        pipeline_template: { type: 'string', enum: ['full_feature', 'quick_fix'] }
```

- [ ] Verify (no code change expected): `commands.create` (`kanban-commands.ts` line 94) does `this.store.createTask({ ...input, ... })`, so `pipelineTemplate` flows through. `kanban-ipc.ts` `KANBAN_CREATE_TASK` does `commands.create(input)`. `src/preload/index.ts` `createTask(input: CreateTaskInput)` invokes the channel with the full input. After Task 2's `CreateTaskInput` change these all typecheck and carry the field. If any of these explicitly destructure fields (rather than spread), add `pipelineTemplate` there — open each and confirm.

- [ ] Add a test. Append to `src/main/__tests__/kanban-mcp-server.test.ts` driving a PM/board-scope `kanban_create` with `pipeline_template: 'full_feature'` and asserting `store.getTask(id)?.pipelineTemplate === 'full_feature'` (copy the nearest PM-scope `kanban_create` test's setup).

- [ ] Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts` — expect green. Then `npm run typecheck` — expect green.

- [ ] Commit:

```
feat(kanban): pipeline_template intake arg through MCP, commands, IPC, preload
```

---

## Task 15 — Renderer: template dropdown + approve_spec card + stage badges

**Files**
- Modify: `src/renderer/src/components/kanban/KanbanBoard.tsx` (create-task form ~line 186; add a `newTemplate` state + dropdown)
- Verify: `src/renderer/src/components/kanban/PmChatPanel.tsx` (~line 217-237 — the proposal card already renders `p.kind.replace(/_/g, ' ')` + Approve/Dismiss generically)
- Modify: `src/renderer/src/components/kanban/KanbanCard.tsx` (stage badge from `pipelineStage`)
- Test: NONE — the repo has no React-component render tests for these views (renderer tests under `src/renderer/.../__tests__/` are pure-util tests like `kanban-utils.test.ts`, `tree-utils.test.ts`; no RTL/jsdom component tests). State this explicitly and verify via `npm run typecheck` + manual smoke is out of scope for the executor.

Steps:

- [ ] In `KanbanBoard.tsx`, add a template state near the other `new*` form state (e.g. `newStatus`):

```tsx
  const [newTemplate, setNewTemplate] = useState<'quick_fix' | 'full_feature'>('quick_fix');
```

- [ ] In `KanbanBoard.tsx`, pass it into the `createTask` call (~line 186). Only send `full_feature` when chosen so non-pipeline tasks stay NULL-equivalent:

```tsx
        await createTask({
          title,
          boardId: activeBoardSlug,
          status: newStatus,
          featureId,
          pipelineTemplate: newTemplate === 'full_feature' ? 'full_feature' : 'quick_fix',
          ...workspace
        });
```

- [ ] In `KanbanBoard.tsx`, add the dropdown to the create-task form near the existing status/mode controls (match the existing `<select>`/control styling in that form):

```tsx
      <select
        value={newTemplate}
        onChange={(e) => setNewTemplate(e.target.value === 'full_feature' ? 'full_feature' : 'quick_fix')}
        className="<copy the className of the adjacent status select>"
      >
        <option value="quick_fix">Quick fix (default)</option>
        <option value="full_feature">Full feature (explore → spec → QA)</option>
      </select>
```

- [ ] In `KanbanBoard.tsx`, reset it on form close alongside `setNewStatus('triage')`:

```tsx
    setNewStatus('triage');
    setNewTemplate('quick_fix');
```

- [ ] Verify `PmChatPanel.tsx` renders the `approve_spec` card. The existing card (lines ~217-237) maps over `proposals` and renders `<span>{p.kind.replace(/_/g, ' ')}</span>` with Approve/Dismiss buttons calling the existing approve/dismiss handlers — so `approve_spec` renders as "approve spec" automatically with no code change. Confirm by reading the block; only adjust copy if a kind-specific label map exists (it does not — leave as-is).

- [ ] In `KanbanCard.tsx`, render a stage badge when `task.pipelineStage` is set. Add near the existing status/PR badges (match the badge styling already used, e.g. `PrStatusBadge`):

```tsx
      {card.pipelineStage && (
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
          {card.pipelineStage}
        </span>
      )}
```

(`KanbanCard` receives a `BoardCard` which extends `Task`, so `card.pipelineStage` is available after Task 2. Confirm the prop name — it may be `task` or `card`; use whichever the component already binds.)

- [ ] Run: `npm run typecheck` (covers `typecheck:web`) — expect green. No renderer unit test to run (stated above).

- [ ] Commit:

```
feat(kanban): template dropdown, stage badges, approve_spec proposal card
```

---

## Task 16 — Final verification

**Files**
- None (verification only)

Steps:

- [ ] Run `npm run typecheck` — expect: both `typecheck:node` and `typecheck:web` pass with no errors.
- [ ] Run `npm run lint` — expect: no NEW lint errors attributable to the new/changed files (the repo is pre-existing-red; compare against the baseline — your new files in `src/main/kanban/pipeline-templates.ts`, `src/main/kanban/template-expander.ts`, and the test files must not introduce new violations).
- [ ] Run `npx vitest run` — expect: all suites green, including `pipeline-templates.test.ts`, `template-expander.test.ts`, `kanban-store.test.ts` (all `toBe(18)`), `kanban-dispatcher.test.ts`, `kanban-mcp-server.test.ts`, `kanban-commands.test.ts`, `spawn-worker.test.ts`, `default-profiles.test.ts`.
- [ ] Run `npm run build` — expect: typecheck passes then electron-vite build succeeds with no errors.
- [ ] Confirm the end-to-end shape against the spec: a `full_feature` triage task → expander lays down explore(ready)/spec(todo)/gate(blocked)/qa(todo) → explore spawns `explore` mode → spec spawns `spec` mode and fans out implement children linked to gate+qa → dispatcher raises `approve_spec` → approve marks gate done → children promote → review (existing autoReview) → qa spawns `qa` mode → `qa_verdict='pass'` lets `markFeaturePrReady` flip the PR. `quick_fix`/NULL is unchanged.

---

## Notes for the executor

- Several MCP-server and commands tests say "copy the nearest existing test's setup" — this is deliberate: those suites have suite-local harness helpers (server construction, run/scope registration) whose exact names must be read from the file, not guessed. Open the file, copy the closest analogous test verbatim, then swap in the pipeline assertions given here.
- Private dispatcher methods are tested via bracket access (`disp['raiseSpecApprovals']()`) — this is allowed in test files only.
- The `pipeline_expanded` event payload field names (`exploreId`, `specId`, `gateId`, `qaId`, `featureId`) are the contract shared by Tasks 4, 7, and 8 — keep them identical.
- Event kinds shared across tasks (`children_emitted`, `spec_approval_raised`, `spec_approved`, `qa_rearmed`, `qa_passed`, `qa_changes_requested`, `blocked`, `pipeline_expanded`) are string contracts — spell them identically.
