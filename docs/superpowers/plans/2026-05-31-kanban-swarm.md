# Kanban Swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, LLM-free helper that writes a swarm task graph (root/blackboard → N workers → verifier → synthesizer) into the existing kanban kernel, launchable from the dashboard, the CLI, and an MCP tool.

**Architecture:** A pure helper module (`kanban-swarm.ts`) builds the graph through existing `KanbanStore` methods. A single `KanbanCommands.createSwarm()` wraps it (defaults, board scoping, validation, transaction, post-commit events). Three thin adapters call that one method: a CLI socket verb, an IPC channel + dashboard modal, and an MCP tool. Two supporting kernel changes: a public `KanbanStore.transaction()` and a promotion gate that counts `archived` as settled.

**Tech Stack:** Electron + electron-vite, TypeScript, better-sqlite3, zustand, React, vitest, zod (MCP arg parsing), lucide-react (icons).

**Reference:** spec at `docs/superpowers/specs/2026-05-31-kanban-swarm-design.md`; hermes source at `reference/hermes-agent/hermes_cli/kanban_swarm.py`.

---

## File Structure

**Create:**
- `src/main/kanban/kanban-swarm.ts` — pure helper: `BLACKBOARD_PREFIX`, `swarmContext`, `parseWorkerArg`, `postBlackboardUpdate`, `latestBlackboard`, `isSwarmRoot`, `createSwarm`.
- `src/main/__tests__/kanban-swarm.test.ts` — unit tests for the helper.
- `src/renderer/src/components/kanban/SwarmModal.tsx` — dashboard modal + a pure `rowsToWorkerSpecs` helper.
- `src/renderer/src/components/kanban/__tests__/swarm-modal.test.ts` — tests for `rowsToWorkerSpecs`.

**Modify:**
- `src/shared/kanban-types.ts` — add `SwarmWorkerSpec`, `SwarmInput`, `SwarmCreated`.
- `src/main/kanban/kanban-store.ts` — add `transaction()`; relax `promotableTodoTasks` gate.
- `src/main/__tests__/kanban-store.test.ts` — gate + transaction tests.
- `src/main/kanban/kanban-commands.ts` — add `createSwarm()`; add `getProfiles` constructor arg.
- `src/main/__tests__/kanban-commands.test.ts` — command tests.
- `src/main/kanban/kanban-mcp-server.ts` — blackboard tools + `kanban_swarm` creation tool + `setSwarmHandler`.
- `src/main/__tests__/kanban-mcp-server.test.ts` — MCP tool tests.
- `src/main/index.ts` — pass `getProfiles` to `KanbanCommands`; call `kanbanMcp.setSwarmHandler(...)`.
- `src/main/socket-server.ts` — `kanban.swarm` case.
- `src/main/fleet-cli.ts` — repeatable `--worker`, positional goal remap, `kanban.swarm` validation, help text.
- `src/main/__tests__/fleet-cli.test.ts` — CLI parse tests.
- `src/shared/ipc-channels.ts` — `KANBAN_CREATE_SWARM`.
- `src/main/kanban/kanban-ipc.ts` — IPC handler.
- `src/preload/index.ts` — `kanban.createSwarm`.
- `src/renderer/src/store/kanban-store.ts` — `createSwarm` action.
- `src/renderer/src/components/kanban/KanbanBoard.tsx` — Swarm toolbar button.

**Verification commands** (run from repo root):
- Single test file: `npx vitest run src/main/__tests__/kanban-swarm.test.ts`
- Full suite: `npx vitest run`
- Types: `npm run typecheck`
- Lint (changed files only — the repo has a large pre-existing lint baseline): `npx eslint <file>`

---

## Task 1: `KanbanStore.transaction()`

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/kanban-store.test.ts` (reuse the file's existing `makeStore`/temp-dir harness; if it has none, mirror the pattern from `kanban-dispatcher.test.ts`: construct `new KanbanStore(join(TEST_DIR, 'tx.db'))`).

```ts
describe('KanbanStore.transaction', () => {
  it('commits all writes when the function returns', () => {
    const store = new KanbanStore(join(TEST_DIR, `tx-ok-${Math.random()}.db`));
    const ids = store.transaction(() => {
      const a = store.createTask({ title: 'a' });
      const b = store.createTask({ title: 'b' });
      store.addLink(a.id, b.id);
      return [a.id, b.id];
    });
    expect(store.getTask(ids[0])).not.toBeNull();
    expect(store.getTask(ids[1])).not.toBeNull();
    expect(store.parentsOf(ids[1])).toEqual([ids[0]]);
  });

  it('rolls back every write when the function throws', () => {
    const store = new KanbanStore(join(TEST_DIR, `tx-rollback-${Math.random()}.db`));
    expect(() =>
      store.transaction(() => {
        store.createTask({ title: 'doomed' });
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(store.listTasks()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t transaction`
Expected: FAIL — `store.transaction is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/main/kanban/kanban-store.ts`, add this method to the `KanbanStore` class (place it just below the constructor, before `migrate`):

```ts
  /** Run `fn` inside a single SQLite transaction. Rolls back if `fn` throws. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t transaction`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): expose KanbanStore.transaction for atomic multi-row writes"
```

---

## Task 2: Promotion gate counts `archived` as settled

**Files:**
- Modify: `src/main/kanban/kanban-store.ts:281-294` (`promotableTodoTasks`)
- Test: `src/main/__tests__/kanban-store.test.ts`

This is the spec's one cross-cutting change: a `todo` task is promotable when no parent is still active (`done` OR `archived`), matching hermes. It lets a user release a stalled swarm by archiving a failed worker, and is correct for ordinary graphs too.

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/kanban-store.test.ts`:

```ts
describe('KanbanStore.promotableTodoTasks gate', () => {
  function fresh(): KanbanStore {
    return new KanbanStore(join(TEST_DIR, `gate-${Math.random()}.db`));
  }

  it('promotes a child whose only parent is done', () => {
    const store = fresh();
    const parent = store.createTask({ title: 'p', status: 'done' });
    const child = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(parent.id, child.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).toContain(child.id);
  });

  it('promotes a child whose only parent is archived', () => {
    const store = fresh();
    const parent = store.createTask({ title: 'p', status: 'archived' });
    const child = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(parent.id, child.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).toContain(child.id);
  });

  it('does NOT promote a child with a blocked parent', () => {
    const store = fresh();
    const parent = store.createTask({ title: 'p', status: 'blocked' });
    const child = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(parent.id, child.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).not.toContain(child.id);
  });

  it('does NOT promote until ALL parents are settled', () => {
    const store = fresh();
    const p1 = store.createTask({ title: 'p1', status: 'done' });
    const p2 = store.createTask({ title: 'p2', status: 'running' });
    const child = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(p1.id, child.id);
    store.addLink(p2.id, child.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).not.toContain(child.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "promotableTodoTasks gate"`
Expected: FAIL — the "archived" case is not promoted by the current `p.status != 'done'` predicate.

- [ ] **Step 3: Write minimal implementation**

In `src/main/kanban/kanban-store.ts`, change the `promotableTodoTasks` query. Replace:

```ts
         WHERE l.child_id = t.id AND p.status != 'done'
```

with:

```ts
         WHERE l.child_id = t.id AND p.status NOT IN ('done','archived')
```

Also update the method's doc comment from `/** Todo tasks whose parents (if any) are all 'done'. */` to:

```ts
  /** Todo tasks whose parents (if any) are all settled (done or archived). */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "promotableTodoTasks gate"`
Expected: PASS (all four cases).
Then run the existing dispatcher tests to confirm no regression: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): treat archived parents as settled in promotion gate"
```

---

## Task 3: Shared swarm types + helper scaffolding (`BLACKBOARD_PREFIX`, `swarmContext`, `parseWorkerArg`)

**Files:**
- Modify: `src/shared/kanban-types.ts`
- Create: `src/main/kanban/kanban-swarm.ts`
- Test: `src/main/__tests__/kanban-swarm.test.ts`

- [ ] **Step 1: Add the shared types**

Append to `src/shared/kanban-types.ts` (after the existing interfaces):

```ts
/** One parallel worker card in a swarm. */
export interface SwarmWorkerSpec {
  profile: string;
  title: string;
  body?: string;
  skills?: string[];
  priority?: number;
}

/** Input to create a swarm graph. Workspace/runtime fields are resolved by the command layer. */
export interface SwarmInput {
  goal: string;
  workers: SwarmWorkerSpec[];
  verifierAssignee: string;
  synthesizerAssignee: string;
  boardId?: string;
  tenant?: string | null;
  priority?: number;
  workspaceKind?: WorkspaceKind;
  repoPath?: string;
  maxRuntimeSeconds?: number | null;
  rootTitle?: string;
  verifierTitle?: string;
  synthesizerTitle?: string;
  createdBy?: string;
}

/** IDs produced by createSwarm. */
export interface SwarmCreated {
  rootId: string;
  workerIds: string[];
  verifierId: string;
  synthesizerId: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/main/__tests__/kanban-swarm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseWorkerArg, swarmContext, BLACKBOARD_PREFIX } from '../kanban/kanban-swarm';

describe('parseWorkerArg', () => {
  it('parses profile:title', () => {
    expect(parseWorkerArg('researcher:Investigate funding')).toEqual({
      profile: 'researcher',
      title: 'Investigate funding',
      body: 'Investigate funding',
      skills: []
    });
  });

  it('parses profile:title:skill,skill', () => {
    expect(parseWorkerArg('sre:Audit infra:reliability,oncall')).toEqual({
      profile: 'sre',
      title: 'Audit infra',
      body: 'Audit infra',
      skills: ['reliability', 'oncall']
    });
  });

  it('keeps colons in the title (split limited to profile + remainder)', () => {
    const spec = parseWorkerArg('writer:Draft: the report');
    expect(spec.profile).toBe('writer');
    expect(spec.title).toBe('Draft: the report');
  });

  it('throws when there is no title', () => {
    expect(() => parseWorkerArg('researcher')).toThrow();
  });
});

describe('swarmContext', () => {
  it('names the root id and goal and the blackboard tools', () => {
    const ctx = swarmContext('root123', 'Design failover');
    expect(ctx).toContain('root123');
    expect(ctx).toContain('Design failover');
    expect(ctx).toContain('kanban_swarm_read');
    expect(ctx).toContain('kanban_swarm_post');
  });
});

describe('BLACKBOARD_PREFIX', () => {
  it('has the exact hermes value with a trailing space', () => {
    expect(BLACKBOARD_PREFIX).toBe('[swarm:blackboard] ');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-swarm.test.ts`
Expected: FAIL — cannot find module `../kanban/kanban-swarm`.

- [ ] **Step 4: Write minimal implementation**

Create `src/main/kanban/kanban-swarm.ts`:

```ts
import type { SwarmWorkerSpec } from '../../shared/kanban-types';

export const BLACKBOARD_PREFIX = '[swarm:blackboard] ';

/** The "## Swarm protocol" suffix appended to every swarm card body. */
export function swarmContext(rootId: string, goal: string): string {
  return (
    '\n\n## Swarm protocol\n' +
    `- Swarm root / shared blackboard: ${rootId}.\n` +
    '- Read sibling/parent findings with the kanban_swarm_read tool (root above).\n' +
    '- Post cross-worker facts with the kanban_swarm_post tool (root above).\n' +
    `- Goal: ${goal.trim()}\n`
  );
}

/** Parse a CLI `--worker profile:title[:skill,skill]` value. Body defaults to the title. */
export function parseWorkerArg(raw: string): SwarmWorkerSpec {
  const firstColon = raw.indexOf(':');
  if (firstColon < 0) {
    throw new Error('worker must be profile:title or profile:title:skill,skill');
  }
  const profile = raw.slice(0, firstColon).trim();
  const rest = raw.slice(firstColon + 1);
  // Skills, if present, are the final ":a,b" segment.
  const lastColon = rest.lastIndexOf(':');
  let title = rest;
  let skills: string[] = [];
  if (lastColon >= 0) {
    const tail = rest.slice(lastColon + 1);
    // Treat the tail as skills only when it looks like a comma list of skill tokens.
    if (tail.trim() !== '' && /^[a-zA-Z0-9_,\- ]+$/.test(tail) && tail.includes(',')) {
      title = rest.slice(0, lastColon);
      skills = tail.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  title = title.trim();
  if (profile === '' || title === '') {
    throw new Error('worker must be profile:title or profile:title:skill,skill');
  }
  return { profile, title, body: title, skills };
}
```

Note: the skills heuristic requires a comma so a plain `writer:Draft: the report` keeps its colon in the title (covered by the test). Single-skill `profile:title:skill` without a comma is treated as part of the title — document this in help text by recommending `profile:title:skillA,skillB` or omitting skills (acceptable v1 limitation).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-swarm.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/kanban-types.ts src/main/kanban/kanban-swarm.ts src/main/__tests__/kanban-swarm.test.ts
git commit -m "feat(kanban): swarm types + parseWorkerArg/swarmContext scaffolding"
```

---

## Task 4: Blackboard read/write (`postBlackboardUpdate`, `latestBlackboard`)

**Files:**
- Modify: `src/main/kanban/kanban-swarm.ts`
- Test: `src/main/__tests__/kanban-swarm.test.ts`

The helper depends only on `addComment`/`listComments`, so the test uses a tiny in-memory stub (no DB needed).

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/kanban-swarm.test.ts`:

```ts
import { postBlackboardUpdate, latestBlackboard } from '../kanban/kanban-swarm';
import type { TaskComment } from '../../shared/kanban-types';

function commentStore() {
  const rows: TaskComment[] = [];
  let id = 1;
  return {
    addComment(taskId: string, author: string, body: string): TaskComment {
      const c = { id: id++, taskId, author, body, createdAt: id };
      rows.push(c);
      return c;
    },
    listComments(taskId: string): TaskComment[] {
      return rows.filter((r) => r.taskId === taskId);
    }
  };
}

describe('blackboard', () => {
  it('round-trips a structured update', () => {
    const store = commentStore();
    postBlackboardUpdate(store, 'root', 'alice', 'finding', { score: 9 });
    expect(latestBlackboard(store, 'root')).toEqual({
      finding: { score: 9 },
      _authors: { finding: 'alice' }
    });
  });

  it('last write wins per key and tracks the winning author', () => {
    const store = commentStore();
    postBlackboardUpdate(store, 'root', 'alice', 'k', 1);
    postBlackboardUpdate(store, 'root', 'bob', 'k', 2);
    const bb = latestBlackboard(store, 'root');
    expect(bb.k).toBe(2);
    expect((bb._authors as Record<string, string>).k).toBe('bob');
  });

  it('ignores non-prefixed and unparseable comments', () => {
    const store = commentStore();
    store.addComment('root', 'human', 'just a normal comment');
    store.addComment('root', 'human', BLACKBOARD_PREFIX + 'not json');
    postBlackboardUpdate(store, 'root', 'alice', 'k', 'v');
    expect(latestBlackboard(store, 'root')).toEqual({ k: 'v', _authors: { k: 'alice' } });
  });

  it('returns an empty object when there are no blackboard comments', () => {
    const store = commentStore();
    expect(latestBlackboard(store, 'root')).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-swarm.test.ts -t blackboard`
Expected: FAIL — `postBlackboardUpdate`/`latestBlackboard` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/main/kanban/kanban-swarm.ts` (and add the import at the top):

```ts
import type { SwarmWorkerSpec, TaskComment } from '../../shared/kanban-types';

/** The subset of KanbanStore the blackboard helpers need. */
export interface BlackboardStore {
  addComment(taskId: string, author: string, body: string): TaskComment;
  listComments(taskId: string): TaskComment[];
}

/** Append one structured update to a swarm root's blackboard. */
export function postBlackboardUpdate(
  store: BlackboardStore,
  rootId: string,
  author: string,
  key: string,
  value: unknown
): TaskComment {
  const body = BLACKBOARD_PREFIX + JSON.stringify({ key, value });
  return store.addComment(rootId, author, body);
}

/** Merge a root's blackboard comments, last-write-wins per key, with winning authors. */
export function latestBlackboard(
  store: BlackboardStore,
  rootId: string
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const authors: Record<string, string> = {};
  for (const comment of store.listComments(rootId)) {
    const body = comment.body ?? '';
    if (!body.startsWith(BLACKBOARD_PREFIX)) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(body.slice(BLACKBOARD_PREFIX.length));
    } catch {
      continue;
    }
    if (typeof payload !== 'object' || payload === null) continue;
    const key = (payload as { key?: unknown }).key;
    if (typeof key !== 'string' || key === '') continue;
    merged[key] = (payload as { value?: unknown }).value;
    authors[key] = comment.author;
  }
  if (Object.keys(authors).length > 0) merged._authors = authors;
  return merged;
}
```

(Remove the now-duplicated `import type { SwarmWorkerSpec }` line from Task 3 — the merged import above replaces it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-swarm.test.ts`
Expected: PASS (all blackboard + Task 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-swarm.ts src/main/__tests__/kanban-swarm.test.ts
git commit -m "feat(kanban): swarm blackboard read/write helpers"
```

---

## Task 5: `createSwarm` topology + `isSwarmRoot`

**Files:**
- Modify: `src/main/kanban/kanban-swarm.ts`
- Test: `src/main/__tests__/kanban-swarm.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/kanban-swarm.test.ts` (uses a real `KanbanStore` against a temp DB):

```ts
import { createSwarm, isSwarmRoot } from '../kanban/kanban-swarm';
import { KanbanStore } from '../kanban/kanban-store';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SWARM_DIR = join(tmpdir(), `fleet-swarm-test-${Date.now()}`);

describe('createSwarm topology', () => {
  beforeEach(() => mkdirSync(SWARM_DIR, { recursive: true }));
  afterEach(() => rmSync(SWARM_DIR, { recursive: true, force: true }));

  function store(): KanbanStore {
    return new KanbanStore(join(SWARM_DIR, `s-${Math.random()}.db`));
  }

  it('builds root(done) → workers(todo) → verifier(todo) → synthesizer(todo)', () => {
    const s = store();
    const created = createSwarm(s, {
      goal: 'Design a failover plan',
      workers: [
        { profile: 'researcher', title: 'Research', body: 'Research', skills: [] },
        { profile: 'architect', title: 'Architect', body: 'Architect', skills: ['systems'] }
      ],
      verifierAssignee: 'reviewer',
      synthesizerAssignee: 'writer'
    });

    const root = s.getTask(created.rootId)!;
    expect(root.status).toBe('done');

    expect(created.workerIds).toHaveLength(2);
    for (const id of created.workerIds) {
      const w = s.getTask(id)!;
      expect(w.status).toBe('todo');
      expect(w.assignee).not.toBeNull();
      expect(s.parentsOf(id)).toEqual([created.rootId]);
      expect(w.body).toContain('## Swarm protocol');
    }
    expect(s.getTask(created.workerIds[1])!.skills).toEqual(['systems']);

    const verifier = s.getTask(created.verifierId)!;
    expect(verifier.status).toBe('todo');
    expect(verifier.assignee).toBe('reviewer');
    expect(verifier.skills).toEqual(['requesting-code-review']);
    expect(s.parentsOf(created.verifierId).sort()).toEqual([...created.workerIds].sort());

    const synth = s.getTask(created.synthesizerId)!;
    expect(synth.status).toBe('todo');
    expect(synth.assignee).toBe('writer');
    expect(s.parentsOf(created.synthesizerId)).toEqual([created.verifierId]);
  });

  it('stores topology on the blackboard and is detectable as a swarm root', () => {
    const s = store();
    const created = createSwarm(s, {
      goal: 'g',
      workers: [{ profile: 'w', title: 't', body: 't', skills: [] }],
      verifierAssignee: 'v',
      synthesizerAssignee: 'y'
    });
    const bb = latestBlackboard(s, created.rootId);
    expect((bb.topology as { kind: string }).kind).toBe('kanban_swarm_v1');
    expect(isSwarmRoot(s, created.rootId)).toBe(true);
    expect(isSwarmRoot(s, created.verifierId)).toBe(false);
  });

  it('applies workspaceKind to every card', () => {
    const s = store();
    const created = createSwarm(s, {
      goal: 'g',
      workers: [{ profile: 'w', title: 't', body: 't', skills: [] }],
      verifierAssignee: 'v',
      synthesizerAssignee: 'y',
      workspaceKind: 'worktree',
      repoPath: '/tmp/repo'
    });
    expect(s.getTask(created.workerIds[0])!.workspaceKind).toBe('worktree');
    expect(s.getTask(created.synthesizerId)!.workspaceKind).toBe('worktree');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-swarm.test.ts -t "createSwarm topology"`
Expected: FAIL — `createSwarm`/`isSwarmRoot` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/main/kanban/kanban-swarm.ts`. First extend the imports:

```ts
import type {
  SwarmWorkerSpec,
  SwarmInput,
  SwarmCreated,
  TaskComment,
  Task,
  CreateTaskInput,
  WorkspaceKind
} from '../../shared/kanban-types';
```

Then add a wider store interface and the functions:

```ts
/** The subset of KanbanStore createSwarm needs. Extends BlackboardStore. */
export interface SwarmStore extends BlackboardStore {
  createTask(input: CreateTaskInput): Task;
  completeTask(taskId: string, result: string | null): void;
  addLink(parentId: string, childId: string): void;
  getTask(id: string): Task | null;
}

const SWARM_ROOT_KIND = 'kanban_swarm_v1';

/** True when `rootId` is a swarm root (its blackboard carries the topology marker). */
export function isSwarmRoot(store: BlackboardStore, rootId: string): boolean {
  const topology = latestBlackboard(store, rootId).topology;
  return (
    typeof topology === 'object' &&
    topology !== null &&
    (topology as { kind?: unknown }).kind === SWARM_ROOT_KIND
  );
}

/**
 * Create a swarm graph. The root is created then completed immediately; workers,
 * verifier, and synthesizer are created `todo` with the gating links. Emits no
 * events (the caller wraps this in a transaction and emits after commit).
 */
export function createSwarm(store: SwarmStore, input: SwarmInput): SwarmCreated {
  const goal = input.goal.trim();
  const createdBy = input.createdBy ?? 'swarm-orchestrator';
  const workspaceKind: WorkspaceKind = input.workspaceKind ?? 'scratch';
  const common = {
    boardId: input.boardId,
    tenant: input.tenant ?? null,
    workspaceKind,
    repoPath: input.repoPath,
    maxRuntimeSeconds: input.maxRuntimeSeconds ?? null
  };

  // Root.
  const root = store.createTask({
    title: input.rootTitle ?? `Swarm: ${goal.split('\n')[0].slice(0, 80)}`,
    body:
      'Kanban Swarm planning/root card. Completed immediately so workers can start; ' +
      `remains the shared blackboard and audit anchor.\n\nGoal:\n${goal}`,
    assignee: createdBy,
    priority: input.priority ?? 0,
    ...common
  });
  store.completeTask(root.id, 'Swarm topology planned; root is the shared blackboard.');

  const suffix = swarmContext(root.id, goal);

  // Workers.
  const workerIds: string[] = [];
  for (const spec of input.workers) {
    const w = store.createTask({
      title: spec.title,
      body: (spec.body ?? spec.title) + suffix,
      assignee: spec.profile,
      status: 'todo',
      priority: spec.priority ?? input.priority ?? 0,
      skills: spec.skills ?? [],
      ...common
    });
    store.addLink(root.id, w.id);
    workerIds.push(w.id);
  }

  // Verifier (gated on all workers).
  const verifier = store.createTask({
    title: input.verifierTitle ?? 'Verify swarm outputs',
    body:
      'Review every worker handoff and blackboard update. Complete ONLY when the ' +
      'evidence is sufficient; otherwise block with the exact missing work (blocking ' +
      'withholds the synthesizer).' +
      suffix,
    assignee: input.verifierAssignee,
    status: 'todo',
    priority: input.priority ?? 0,
    skills: ['requesting-code-review'],
    ...common
  });
  for (const id of workerIds) store.addLink(id, verifier.id);

  // Synthesizer (gated on verifier).
  const synthesizer = store.createTask({
    title: input.synthesizerTitle ?? 'Synthesize swarm outputs',
    body:
      'Synthesize the verified worker outputs into the final deliverable. Read the ' +
      'blackboard for all findings.' +
      suffix,
    assignee: input.synthesizerAssignee,
    status: 'todo',
    priority: input.priority ?? 0,
    ...common
  });
  store.addLink(verifier.id, synthesizer.id);

  const created: SwarmCreated = {
    rootId: root.id,
    workerIds,
    verifierId: verifier.id,
    synthesizerId: synthesizer.id
  };
  postBlackboardUpdate(store, root.id, createdBy, 'topology', {
    kind: SWARM_ROOT_KIND,
    ...created,
    goal
  });
  return created;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-swarm.test.ts`
Expected: PASS (all cases).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-swarm.ts src/main/__tests__/kanban-swarm.test.ts
git commit -m "feat(kanban): createSwarm topology builder + isSwarmRoot"
```

---

## Task 6: `KanbanCommands.createSwarm` + `getProfiles` wiring

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Modify: `src/main/index.ts` (pass `getProfiles`)
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/kanban-commands.test.ts`. Match the file's existing construction of `KanbanCommands` (store + dispatcher + defaults closure); add the 4th `getProfiles` arg.

```ts
describe('KanbanCommands.createSwarm', () => {
  function setup(profiles: Array<{ name: string; role: string }> = []) {
    const store = new KanbanStore(join(TEST_DIR, `cmd-swarm-${Math.random()}.db`));
    const dispatcher = new KanbanDispatcher(store, {
      now: () => Date.now(),
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        maxDecompose: 1
      }
    });
    const events: string[] = [];
    store['onEvent'] = (e) => events.push(e.kind); // capture emitted kinds
    const commands = new KanbanCommands(
      store,
      dispatcher,
      () => ({ workspaceKind: 'scratch', maxRuntimeSeconds: null }),
      () => profiles
    );
    return { store, commands, events };
  }

  const base = {
    goal: 'Plan failover',
    workers: [{ profile: 'researcher', title: 'Research' }],
    verifierAssignee: 'reviewer',
    synthesizerAssignee: 'writer'
  };

  it('creates the graph and emits swarm_created + per-card task_created', () => {
    const { commands, events, store } = setup([
      { name: 'researcher', role: 'worker' },
      { name: 'reviewer', role: 'worker' },
      { name: 'writer', role: 'worker' }
    ]);
    const created = commands.createSwarm(base);
    expect(store.getTask(created.rootId)!.status).toBe('done');
    expect(events).toContain('swarm_created');
    expect(events.filter((k) => k === 'task_created')).toHaveLength(3); // 1 worker + verifier + synth
  });

  it('rejects an empty workers list', () => {
    const { commands } = setup();
    expect(() => commands.createSwarm({ ...base, workers: [] })).toThrow();
  });

  it('rejects an unknown worker profile when profiles are configured', () => {
    const { commands } = setup([{ name: 'reviewer', role: 'worker' }, { name: 'writer', role: 'worker' }]);
    expect(() => commands.createSwarm(base)).toThrow(/unknown worker profile/);
  });

  it('rejects a worktree swarm with no repoPath', () => {
    const { commands } = setup([
      { name: 'researcher', role: 'worker' },
      { name: 'reviewer', role: 'worker' },
      { name: 'writer', role: 'worker' }
    ]);
    expect(() => commands.createSwarm({ ...base, workspaceKind: 'worktree' })).toThrow(/repo/);
  });

  it('rejects more than the worker cap', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ profile: 'researcher', title: `t${i}` }));
    const { commands } = setup([{ name: 'researcher', role: 'worker' }]);
    expect(() => commands.createSwarm({ ...base, workers: many })).toThrow(/at most/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t createSwarm`
Expected: FAIL — `createSwarm` is not a method; constructor takes 3 args.

- [ ] **Step 3: Write minimal implementation**

In `src/main/kanban/kanban-commands.ts`:

Add imports:

```ts
import { createSwarm as buildSwarm } from './kanban-swarm';
import type { SwarmInput, SwarmCreated, WorkerProfile } from '../../shared/kanban-types';
```

(If `WorkerProfile` lives in `../../shared/types`, import it from there instead; the test only needs `{ name, role }`, so type the param structurally.)

Add a constant near the top of the file:

```ts
/** Upper bound on workers per swarm — keeps one swarm from monopolizing the global dispatcher. */
export const SWARM_MAX_WORKERS = 20;
```

Change the constructor to accept profiles (default keeps existing callers working):

```ts
  constructor(
    private store: KanbanStore,
    private dispatcher: KanbanDispatcher,
    private getCreateDefaults: () => CreateDefaults,
    private getProfiles: () => Array<{ name: string; role: string }> = () => []
  ) {}
```

Add the method (place it after `create`):

```ts
  createSwarm(input: SwarmInput): SwarmCreated {
    const goal = (input.goal ?? '').trim();
    if (goal === '') throw new CodedError('swarm requires a goal', 'BAD_REQUEST');
    const workers = input.workers ?? [];
    if (workers.length < 1) {
      throw new CodedError('swarm requires at least one worker', 'BAD_REQUEST');
    }
    if (workers.length > SWARM_MAX_WORKERS) {
      throw new CodedError(`swarm supports at most ${SWARM_MAX_WORKERS} workers`, 'BAD_REQUEST');
    }
    if (!(input.verifierAssignee ?? '').trim()) {
      throw new CodedError('swarm requires a verifier', 'BAD_REQUEST');
    }
    if (!(input.synthesizerAssignee ?? '').trim()) {
      throw new CodedError('swarm requires a synthesizer', 'BAD_REQUEST');
    }

    const d = this.getCreateDefaults();
    const workspaceKind = input.workspaceKind ?? d.workspaceKind;
    if (workspaceKind === 'worktree' && !input.repoPath) {
      throw new CodedError('worktree swarms require a source repo (repoPath)', 'BAD_REQUEST');
    }

    const profiles = this.getProfiles();
    const workerProfiles = new Set(profiles.filter((p) => p.role === 'worker').map((p) => p.name));
    for (const w of workers) {
      if (!(w.profile ?? '').trim()) throw new CodedError('each worker requires a profile', 'BAD_REQUEST');
      if (!(w.title ?? '').trim()) throw new CodedError('each worker requires a title', 'BAD_REQUEST');
      if (workerProfiles.size > 0 && !workerProfiles.has(w.profile)) {
        throw new CodedError(`unknown worker profile: ${w.profile}`, 'BAD_REQUEST');
      }
    }

    const resolved: SwarmInput = {
      ...input,
      goal,
      workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    };

    const created = this.store.transaction(() => buildSwarm(this.store, resolved));

    // Emit after commit so IPC/notifier never fire mid-transaction.
    this.store.appendEvent(created.rootId, null, 'swarm_created', {
      goal,
      workerCount: workers.length
    });
    for (const id of [...created.workerIds, created.verifierId, created.synthesizerId]) {
      const t = this.store.getTask(id);
      this.store.appendEvent(id, null, 'task_created', { title: t?.title ?? '' });
    }
    return created;
  }
```

Now wire production profiles in `src/main/index.ts`. Change the `KanbanCommands` construction (around line 880):

```ts
  kanbanCommands = new KanbanCommands(
    kanbanStore,
    kanbanDispatcher,
    () => {
      const d = settingsStore.get().kanban.defaults;
      return { workspaceKind: d.workspaceKind, maxRuntimeSeconds: d.maxRuntimeSeconds };
    },
    () => settingsStore.get().kanban.profiles
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t createSwarm`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/index.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): KanbanCommands.createSwarm with validation + atomic build"
```

---

## Task 7: MCP blackboard tools (`kanban_swarm_read`, `kanban_swarm_post`)

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/kanban-mcp-server.test.ts`. The file already provides the `rpc(url, method, params)` helper, the `server`/`store`/`base` fixtures, and the `?run=<token>` calling convention. Add the swarm import at the top of the file (`import { createSwarm } from '../kanban/kanban-swarm';`).

```ts
  it('kanban_swarm_post then kanban_swarm_read round-trips on a swarm root', async () => {
    const created = createSwarm(store, {
      goal: 'g',
      workers: [{ profile: 'w', title: 't', body: 't', skills: [] }],
      verifierAssignee: 'v',
      synthesizerAssignee: 'y'
    });
    const workerId = created.workerIds[0];
    store.claimTask(workerId, 'LOCK', 100000);
    const run = store.startRun(workerId, 'w', 1);
    server.registerRun('toksw', { taskId: workerId, runId: run.id, mode: 'work' }, 'LOCK');

    const post = await rpc(`${base}?run=toksw`, 'tools/call', {
      name: 'kanban_swarm_post',
      arguments: { root: created.rootId, key: 'finding', value: { ok: true } }
    });
    expect(post.result.content[0].text).toMatch(/updated/i);

    const read = await rpc(`${base}?run=toksw`, 'tools/call', {
      name: 'kanban_swarm_read',
      arguments: { root: created.rootId }
    });
    const bb = JSON.parse(read.result.content[0].text);
    expect(bb.finding).toEqual({ ok: true });
    expect(bb.topology.kind).toBe('kanban_swarm_v1');
  });

  it('kanban_swarm_read rejects a non-swarm-root id', async () => {
    const plain = store.createTask({ title: 'plain', status: 'ready', assignee: 'r' });
    store.claimTask(plain.id, 'LOCK', 100000);
    const run = store.startRun(plain.id, 'r', 1);
    server.registerRun('tokplain', { taskId: plain.id, runId: run.id, mode: 'work' }, 'LOCK');

    const r = await rpc(`${base}?run=tokplain`, 'tools/call', {
      name: 'kanban_swarm_read',
      arguments: { root: plain.id }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/not a swarm root/i);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t kanban_swarm`
Expected: FAIL — unknown tool `kanban_swarm_read`.

- [ ] **Step 3: Write minimal implementation**

In `src/main/kanban/kanban-mcp-server.ts`:

Add imports at the top:

```ts
import { latestBlackboard, postBlackboardUpdate, isSwarmRoot } from './kanban-swarm';
```

Add the two tools to `WORKER_TOOLS` (so every swarm card can use them):

```ts
  {
    name: 'kanban_swarm_read',
    description: 'Read the merged shared blackboard of a swarm root (pass its id).',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
      required: ['root']
    }
  },
  {
    name: 'kanban_swarm_post',
    description: 'Post a structured key/value fact to a swarm root blackboard (pass its id).',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, key: { type: 'string' }, value: {} },
      required: ['root', 'key', 'value']
    }
  }
```

Add the cases in `handleToolCall`'s `switch` (after `kanban_comment`):

```ts
        case 'kanban_swarm_read': {
          const a = z.object({ root: z.string() }).parse(args);
          if (!isSwarmRoot(this.store, a.root)) {
            return this.rpcError(res, rpcReq.id, `${a.root} is not a swarm root`);
          }
          return this.text(res, rpcReq.id, JSON.stringify(latestBlackboard(this.store, a.root)));
        }
        case 'kanban_swarm_post': {
          const a = z
            .object({ root: z.string(), key: z.string(), value: z.unknown() })
            .parse(args);
          if (!isSwarmRoot(this.store, a.root)) {
            return this.rpcError(res, rpcReq.id, `${a.root} is not a swarm root`);
          }
          postBlackboardUpdate(this.store, a.root, author, a.key, a.value);
          this.store.appendEvent(a.root, scope.runId, 'comment', { author, blackboard: a.key });
          return this.text(res, rpcReq.id, 'Blackboard updated.');
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t kanban_swarm`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): MCP blackboard read/post tools for swarm workers"
```

---

## Task 8: MCP `kanban_swarm` creation tool + `setSwarmHandler`

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Modify: `src/main/index.ts`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/kanban-mcp-server.test.ts` (the `kanban_swarm` tool is in the orchestrator toolset, so the run must be `mode: 'decompose'`):

```ts
  it('kanban_swarm routes through the injected handler with the scope board', async () => {
    let receivedBoard: string | undefined;
    server.setSwarmHandler((input) => {
      receivedBoard = input.boardId;
      return { rootId: 'r1', workerIds: ['w1'], verifierId: 'v1', synthesizerId: 's1' };
    });
    const orch = store.createTask({ title: 'orch', status: 'ready', assignee: 'orchestrator', boardId: 'default' });
    store.claimTask(orch.id, 'LOCK', 100000);
    const run = store.startRun(orch.id, 'orchestrator', 1);
    server.registerRun('tokorch', { taskId: orch.id, runId: run.id, mode: 'decompose' }, 'LOCK');

    const r = await rpc(`${base}?run=tokorch`, 'tools/call', {
      name: 'kanban_swarm',
      arguments: {
        goal: 'plan it',
        workers: [{ profile: 'researcher', title: 'Research' }],
        verifier: 'reviewer',
        synthesizer: 'writer'
      }
    });
    const out = JSON.parse(r.result.content[0].text);
    expect(out.rootId).toBe('r1');
    expect(out.workerIds).toEqual(['w1']);
    expect(receivedBoard).toBe('default');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t "kanban_swarm creation"`
Expected: FAIL — `setSwarmHandler` undefined / unknown tool `kanban_swarm`.

- [ ] **Step 3: Write minimal implementation**

In `src/main/kanban/kanban-mcp-server.ts`:

Add imports:

```ts
import type { SwarmInput, SwarmCreated } from '../../shared/kanban-types';
```

Add a field + setter to the class (next to `private store`):

```ts
  private swarmHandler: ((input: SwarmInput) => SwarmCreated) | null = null;

  /** Inject the swarm creation handler (KanbanCommands.createSwarm). */
  setSwarmHandler(handler: (input: SwarmInput) => SwarmCreated): void {
    this.swarmHandler = handler;
  }
```

Add the tool to `ORCHESTRATOR_EXTRA_TOOLS` (so it joins `DECOMPOSE_TOOLS`):

```ts
  {
    name: 'kanban_swarm',
    description:
      'Create a swarm graph: N parallel workers, a verifier gated on all workers, ' +
      'and a synthesizer gated on the verifier. Inherits this task board.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        workers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              profile: { type: 'string' },
              title: { type: 'string' },
              skills: { type: 'array', items: { type: 'string' } }
            },
            required: ['profile', 'title']
          }
        },
        verifier: { type: 'string' },
        synthesizer: { type: 'string' }
      },
      required: ['goal', 'workers', 'verifier', 'synthesizer']
    }
  }
```

Add the case in `handleToolCall`:

```ts
        case 'kanban_swarm': {
          if (!this.swarmHandler) {
            return this.rpcError(res, rpcReq.id, 'swarm creation is not available');
          }
          const a = z
            .object({
              goal: z.string(),
              workers: z
                .array(
                  z.object({
                    profile: z.string(),
                    title: z.string(),
                    skills: z.array(z.string()).optional()
                  })
                )
                .min(1),
              verifier: z.string(),
              synthesizer: z.string()
            })
            .parse(args);
          const inheritRepo =
            task.workspaceKind === 'worktree' && task.repoPath
              ? { workspaceKind: 'worktree' as const, repoPath: task.repoPath }
              : {};
          const created = this.swarmHandler({
            goal: a.goal,
            workers: a.workers.map((w) => ({ profile: w.profile, title: w.title, skills: w.skills ?? [] })),
            verifierAssignee: a.verifier,
            synthesizerAssignee: a.synthesizer,
            boardId: task.boardId,
            createdBy: author,
            ...inheritRepo
          });
          return this.text(res, rpcReq.id, JSON.stringify(created));
        }
```

Wire the handler in `src/main/index.ts`, immediately after `kanbanCommands` is constructed (so it exists):

```ts
  kanbanMcp.setSwarmHandler((input) => kanbanCommands!.createSwarm(input));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/index.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): kanban_swarm MCP creation tool wired to the command layer"
```

---

## Task 9: CLI socket verb `kanban.swarm` + flag parsing

**Files:**
- Modify: `src/main/socket-server.ts`
- Modify: `src/main/fleet-cli.ts`
- Test: `src/main/__tests__/fleet-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/fleet-cli.test.ts` (import `parseArgs` if not already imported):

```ts
describe('parseArgs repeatable --worker', () => {
  it('accumulates multiple --worker flags into an array', () => {
    const args = parseArgs(['--worker', 'a:t1', '--worker', 'b:t2', '--verifier', 'v']);
    expect(args.worker).toEqual(['a:t1', 'b:t2']);
    expect(args.verifier).toBe('v');
  });

  it('keeps a single --worker as a string', () => {
    const args = parseArgs(['--worker', 'a:t1']);
    expect(args.worker).toBe('a:t1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts -t "repeatable --worker"`
Expected: FAIL — `args.worker` is the last value (`'b:t2'`), not an array.

- [ ] **Step 3: Write minimal implementation**

In `src/main/fleet-cli.ts`, `parseArgs`: extend the repeated-flag condition. Change:

```ts
        if (key === 'depends-on' || key === 'images') {
```

to:

```ts
        if (key === 'depends-on' || key === 'images' || key === 'worker') {
```

In the `if (group === 'kanban')` positional remap block, add a swarm clause:

```ts
    if (action === 'swarm' && positionals.length >= 1) {
      args.goal = positionals.join(' ');
      delete args.id;
    }
```

Add a `kanban.swarm` validation case in `validateCommand` (next to `kanban.create`):

```ts
    case 'kanban.swarm':
      if (!args.goal)
        return 'Error: kanban swarm requires a goal.\n\nUsage: fleet kanban swarm "<goal>" --worker <profile:title[:skillA,skillB]> [--worker ...] --verifier <profile> --synthesizer <profile>';
      if (!args.worker)
        return 'Error: kanban swarm requires at least one --worker.\n\nUsage: fleet kanban swarm "<goal>" --worker <profile:title> --verifier <profile> --synthesizer <profile>';
      if (!args.verifier)
        return 'Error: kanban swarm requires --verifier <profile>.';
      if (!args.synthesizer)
        return 'Error: kanban swarm requires --synthesizer <profile>.';
      return null;
```

Now add the socket handler in `src/main/socket-server.ts` (a new `case` in the kanban command switch, after `kanban.create`). Add the swarm-helper import at the top of the file:

```ts
import { parseWorkerArg } from './kanban/kanban-swarm';
import type { SwarmWorkerSpec } from '../shared/kanban-types';
```

The case:

```ts
      case 'kanban.swarm': {
        const k = this.requireKanban();
        const goal = typeof args.goal === 'string' ? args.goal : undefined;
        if (!goal) throw new CodedError('kanban swarm requires a goal', 'BAD_REQUEST');
        const verifier = typeof args.verifier === 'string' ? args.verifier : undefined;
        const synthesizer = typeof args.synthesizer === 'string' ? args.synthesizer : undefined;
        if (!verifier) throw new CodedError('kanban swarm requires --verifier', 'BAD_REQUEST');
        if (!synthesizer) throw new CodedError('kanban swarm requires --synthesizer', 'BAD_REQUEST');
        const rawWorkers = Array.isArray(args.worker)
          ? (args.worker as unknown[]).map(String)
          : typeof args.worker === 'string'
            ? [args.worker]
            : [];
        if (rawWorkers.length === 0) {
          throw new CodedError('kanban swarm requires at least one --worker', 'BAD_REQUEST');
        }
        const workers: SwarmWorkerSpec[] = rawWorkers.map((w) => parseWorkerArg(w));
        const created = k.createSwarm({
          goal,
          workers,
          verifierAssignee: verifier,
          synthesizerAssignee: synthesizer,
          ...(typeof args.repo === 'string' ? { workspaceKind: 'worktree' as const, repoPath: args.repo } : {})
        });
        this.emit('state-change', 'kanban:changed', { id: created.rootId });
        return created;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts -t "repeatable --worker"`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/fleet-cli.ts src/main/socket-server.ts src/main/__tests__/fleet-cli.test.ts
git commit -m "feat(kanban): fleet kanban swarm CLI verb + repeatable --worker parsing"
```

---

## Task 10: IPC channel + preload + renderer store action

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/main/kanban/kanban-ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/store/kanban-store.ts`

This task has no standalone unit test (it's IPC plumbing verified by typecheck + the modal in Task 11). Keep each edit minimal.

- [ ] **Step 1: Add the channel constant**

In `src/shared/ipc-channels.ts`, add after `KANBAN_FOCUS_TASK`:

```ts
  KANBAN_CREATE_SWARM: 'kanban:create-swarm',
```

(Add a comma to the previous line if needed.)

- [ ] **Step 2: Add the IPC handler**

In `src/main/kanban/kanban-ipc.ts`, add the `SwarmInput`/`SwarmCreated` import and a handler:

```ts
import type { CreateTaskInput, TaskDetail, Task, ScheduleInput, SwarmInput, SwarmCreated } from '../../shared/kanban-types';
```

```ts
  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_SWARM, (_e, input: SwarmInput): SwarmCreated => {
    return commands.createSwarm(input);
  });
```

- [ ] **Step 3: Expose it in preload**

In `src/preload/index.ts`, inside the `kanban` object, add (and import the types alongside the existing kanban-types imports):

```ts
    createSwarm: async (input: SwarmInput): Promise<SwarmCreated> =>
      typedInvoke<SwarmCreated>(IPC_CHANNELS.KANBAN_CREATE_SWARM, input),
```

Ensure `SwarmInput, SwarmCreated` are imported in preload from `../shared/kanban-types`.

- [ ] **Step 4: Add the renderer store action**

In `src/renderer/src/store/kanban-store.ts`, add to the state type (near `createTask`):

```ts
  createSwarm: (input: SwarmInput) => Promise<SwarmCreated>;
```

and the implementation (after `createTask`), importing `SwarmInput, SwarmCreated`:

```ts
  createSwarm: async (input) => {
    const created = await window.fleet.kanban.createSwarm(input);
    await get().loadBoard();
    return created;
  },
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Expected: PASS (both node + web projects).

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/kanban/kanban-ipc.ts src/preload/index.ts src/renderer/src/store/kanban-store.ts
git commit -m "feat(kanban): IPC + preload + store action for createSwarm"
```

---

## Task 11: Dashboard Swarm modal + toolbar button

**Files:**
- Create: `src/renderer/src/components/kanban/SwarmModal.tsx`
- Create: `src/renderer/src/components/kanban/__tests__/swarm-modal.test.ts`
- Modify: `src/renderer/src/components/kanban/KanbanBoard.tsx`

- [ ] **Step 1: Write the failing test (pure input builder)**

Create `src/renderer/src/components/kanban/__tests__/swarm-modal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rowsToWorkerSpecs } from '../SwarmModal';

describe('rowsToWorkerSpecs', () => {
  it('maps non-empty rows to specs and splits skills on commas', () => {
    const specs = rowsToWorkerSpecs([
      { profile: 'researcher', title: 'Research', skills: 'web, papers' },
      { profile: '', title: 'ignored', skills: '' },
      { profile: 'architect', title: 'Design', skills: '' }
    ]);
    expect(specs).toEqual([
      { profile: 'researcher', title: 'Research', skills: ['web', 'papers'] },
      { profile: 'architect', title: 'Design', skills: [] }
    ]);
  });

  it('drops rows missing a profile or a title', () => {
    expect(rowsToWorkerSpecs([{ profile: 'x', title: '', skills: '' }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/kanban/__tests__/swarm-modal.test.ts`
Expected: FAIL — cannot find module `../SwarmModal`.

- [ ] **Step 3: Implement the modal + helper**

Create `src/renderer/src/components/kanban/SwarmModal.tsx`:

```tsx
import { useState } from 'react';
import { useKanbanStore } from '../../store/kanban-store';
import { useSettingsStore } from '../../store/settings-store';
import type { SwarmWorkerSpec } from '../../../../shared/kanban-types';

export interface WorkerRow {
  profile: string;
  title: string;
  skills: string;
}

/** Pure: turn modal rows into worker specs, dropping incomplete rows. */
export function rowsToWorkerSpecs(rows: WorkerRow[]): SwarmWorkerSpec[] {
  return rows
    .filter((r) => r.profile.trim() !== '' && r.title.trim() !== '')
    .map((r) => ({
      profile: r.profile.trim(),
      title: r.title.trim(),
      skills: r.skills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }));
}

export function SwarmModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const createSwarm = useKanbanStore((s) => s.createSwarm);
  const profiles = useSettingsStore((s) => s.settings?.kanban.profiles ?? []);
  const workerProfiles = profiles.filter((p) => p.role === 'worker');
  const firstWorker = workerProfiles[0]?.name ?? '';

  const [goal, setGoal] = useState('');
  const [rows, setRows] = useState<WorkerRow[]>([{ profile: firstWorker, title: '', skills: '' }]);
  const [verifier, setVerifier] = useState(firstWorker);
  const [synthesizer, setSynthesizer] = useState(firstWorker);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const workers = rowsToWorkerSpecs(rows);
    if (goal.trim() === '' || workers.length === 0 || !verifier || !synthesizer) {
      setError('Goal, at least one complete worker row, a verifier, and a synthesizer are required.');
      return;
    }
    try {
      await createSwarm({ goal: goal.trim(), workers, verifierAssignee: verifier, synthesizerAssignee: synthesizer });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[560px] max-h-[80vh] overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-neutral-100">New Swarm</h2>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Swarm goal / final outcome…"
          className="mb-3 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
          rows={2}
        />
        <div className="mb-2 text-xs font-medium text-neutral-300">Workers</div>
        {rows.map((row, i) => (
          <div key={i} className="mb-2 flex items-center gap-2">
            <select
              value={row.profile}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, profile: e.target.value } : r)))}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            >
              {workerProfiles.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
            <input
              value={row.title}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, title: e.target.value } : r)))}
              placeholder="Task title…"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
            />
            <input
              value={row.skills}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, skills: e.target.value } : r)))}
              placeholder="skills (comma)"
              className="w-28 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
            />
            <button
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
              disabled={rows.length === 1}
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={() => setRows([...rows, { profile: firstWorker, title: '', skills: '' }])}
          className="mb-3 rounded px-2 py-1 text-xs text-blue-400 hover:bg-neutral-800"
        >
          + Add worker
        </button>
        <div className="mb-3 flex gap-3">
          <label className="flex-1 text-xs text-neutral-300">
            Verifier
            <select
              value={verifier}
              onChange={(e) => setVerifier(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            >
              {workerProfiles.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="flex-1 text-xs text-neutral-300">
            Synthesizer
            <select
              value={synthesizer}
              onChange={(e) => setSynthesizer(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            >
              {workerProfiles.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
        {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800">
            Cancel
          </button>
          <button onClick={() => void submit()} className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500">
            Create Swarm
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `npx vitest run src/renderer/src/components/kanban/__tests__/swarm-modal.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the toolbar button**

In `src/renderer/src/components/kanban/KanbanBoard.tsx`:

Extend the lucide import:

```ts
import { Plus, Zap, Archive, Network } from 'lucide-react';
```

Add the modal import and a state flag:

```ts
import { SwarmModal } from './SwarmModal';
```

```ts
  const [swarming, setSwarming] = useState(false);
```

Add a button next to the "New Task" button (after it, inside the same toolbar `div`):

```tsx
        <button
          onClick={() => setSwarming(true)}
          className="inline-flex items-center gap-1 rounded bg-purple-600 px-2 py-1 text-xs text-white hover:bg-purple-500"
          title="Create a swarm: workers → verifier → synthesizer"
        >
          <Network size={12} /> Swarm
        </button>
```

Render the modal (just before the closing fragment/root element of the component's return):

```tsx
      {swarming && <SwarmModal onClose={() => setSwarming(false)} />}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck`
Expected: PASS.
Run: `npx vitest run src/renderer/src/components/kanban/__tests__/swarm-modal.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/kanban/SwarmModal.tsx src/renderer/src/components/kanban/__tests__/swarm-modal.test.ts src/renderer/src/components/kanban/KanbanBoard.tsx
git commit -m "feat(kanban): dashboard Swarm modal + toolbar button"
```

---

## Task 12: CLI help text

**Files:**
- Modify: `src/main/fleet-cli.ts` (the `kanban` help block around line 542)

- [ ] **Step 1: Add the swarm line to the help text**

In the `kanban:` help string, add under the existing usage lines (after the `fleet kanban create …` line):

```
  fleet kanban swarm "<goal>" --worker <profile:title[:skillA,skillB]> [--worker ...] --verifier <profile> --synthesizer <profile> [--repo <path>]
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/fleet-cli.ts
git commit -m "docs(kanban): document fleet kanban swarm in CLI help"
```

---

## Final verification

- [ ] **Run the full suite:** `npx vitest run` — expected: all green (existing + new tests).
- [ ] **Typecheck:** `npm run typecheck` — expected: PASS.
- [ ] **Build:** `npm run build` — expected: succeeds.
- [ ] **Lint changed files only** (repo has a large pre-existing lint baseline): `npx eslint src/main/kanban/kanban-swarm.ts src/main/kanban/kanban-commands.ts src/main/kanban/kanban-mcp-server.ts src/main/socket-server.ts src/main/fleet-cli.ts src/main/kanban/kanban-ipc.ts src/renderer/src/components/kanban/SwarmModal.tsx src/renderer/src/store/kanban-store.ts` — expected: clean.

---

## Manual verification checklist (post-merge)

- Create a 3-worker swarm from the dashboard modal; confirm the root appears `done`, the three workers spawn (3-wide via the dispatcher), and the verifier/synthesizer sit in todo.
- Confirm a worker calls `kanban_swarm_post` and another (or the synthesizer) reads it via `kanban_swarm_read`.
- Confirm the verifier promotes after all workers finish, and the synthesizer promotes after the verifier completes.
- Block one worker; confirm the swarm stalls, a Phase 7 notification fires, and **archiving** the blocked worker releases the verifier gate.
- Run `fleet kanban swarm "test goal" --worker researcher:Research --worker architect:Design:systems --verifier reviewer --synthesizer writer` and confirm the same graph appears on the board.
