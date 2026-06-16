# PM Agent Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Fleet board PM agent from a reactive chat box into an autonomous coordinator that wakes on board events, runs a scheduled standup digest, and holds bounded board authority (acts on safe moves, proposes risky ones for one-click human confirmation).

**Architecture:** A new in-process `PmAutopilot` becomes a *second* consumer of `KanbanStore.onEvent` (the first is `KanbanNotifier`). It decides *when* the PM takes an event-driven turn; the actual turn runs through `pm-chat-service`, refactored so chat/event/digest turns share one serialized per-board session via `runTurn(boardId, prompt, origin)`. Risky board mutations are written to a new `pm_proposals` table for human Approve/Dismiss; safe ones run immediately through new MCP tools. No new process or DB connection.

**Tech Stack:** Electron main process, TypeScript (ESM `.mjs` output), better-sqlite3 (`KanbanStore`), zod for runtime validation, vitest for tests, React + Tailwind renderer. `rune` headless CLI for PM turns.

**Spec:** `docs/superpowers/specs/2026-06-15-pm-agent-upgrades-design.md`

---

## File Structure

**New files:**
- `src/main/kanban/pm-autopilot.ts` — the coordinator: event filter, coalesce, min-gap, single-flight delegation, master gate, cron-digest check, briefing builders.
- `src/main/kanban/__tests__/pm-autopilot.test.ts` — unit tests for the coordinator (clock-injected).
- `src/main/kanban/pm-digest.ts` — pure digest-context builder (events/runs/features since a cutoff → structured summary input).
- `src/main/kanban/__tests__/pm-digest.test.ts` — unit tests for the digest builder.

**Modified files:**
- `src/main/kanban/schema.ts` — `pm_proposals` table DDL + `boards` columns + bump `SCHEMA_VERSION`.
- `src/main/kanban/kanban-store.ts` — proposal accessors, board digest config accessors, `listEventsSince`/`listRunsSince` query helpers, migration.
- `src/shared/kanban-types.ts` — `PmProposal`, `PmProposalKind`, `PmProposalStatus`, `BoardDigestConfig`, `PmTurnOrigin` types.
- `src/shared/types.ts` — `kanban.pm` global settings block.
- `src/shared/constants.ts` — defaults for `kanban.pm`.
- `src/main/settings-store.ts` — merge logic for the new settings block.
- `src/main/kanban/pm-chat-service.ts` — extract `runTurn`, add per-board turn queue + origin log + event/digest entry points.
- `src/main/kanban/pm-agents.ts` — autopilot-mandate persona section.
- `src/main/kanban/kanban-mcp-server.ts` — new safe tools + `kanban_propose` + `set_status` guardrail in `PM_TOOLS`/`handlePmToolCall`.
- `src/main/kanban/kanban-commands.ts` — `requestDecompose`/`requestSpecify` exposure (already exist), proposal create/list/resolve passthroughs, digest-config passthroughs.
- `src/main/kanban/kanban-ipc.ts` — IPC for list/approve/dismiss proposals + get/set digest config.
- `src/shared/ipc-channels.ts` + `src/shared/ipc-api.ts` + `src/renderer/src/ipc-api.ts` — channel constants, request types, preload methods.
- `src/main/index.ts` — construct `PmAutopilot`, wire it as a second `onEvent` consumer, pass config getters.
- `src/renderer/src/components/kanban/PmChat.tsx` (or equivalent PM chat component) — Approve/Dismiss proposal cards + digest-cron control.

---

## Phase A — Data model & config foundations

### Task 1: `pm_proposals` table + types + store accessors

**Files:**
- Modify: `src/shared/kanban-types.ts` (after the `TaskEvent` interface, ~line 284)
- Modify: `src/main/kanban/schema.ts` (`SCHEMA_VERSION` line 1; table DDL near `feature_suggestions` ~line 189)
- Modify: `src/main/kanban/kanban-store.ts` (migration in `migrate()`; accessors near `feature_suggestions` accessors ~line 1656)
- Test: `src/main/kanban/__tests__/pm-proposals-store.test.ts` (new)

- [ ] **Step 1: Add shared types**

In `src/shared/kanban-types.ts`, after the `TaskEvent` interface add:

```typescript
export type PmProposalKind =
  | 'merge_review_task'
  | 'create_pr_for_task'
  | 'accept_review_task'
  | 'ship_feature'
  | 'complete_task'
  | 'archive_task';

export type PmProposalStatus = 'pending' | 'accepted' | 'dismissed' | 'failed';

export interface PmProposal {
  id: string;
  boardId: string;
  kind: PmProposalKind;
  /** Task id, or feature id for ship_feature. */
  targetId: string;
  rationale: string;
  status: PmProposalStatus;
  /** Set when status becomes 'failed': the executor error surfaced to the user. */
  error: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export const PM_PROPOSAL_KINDS = [
  'merge_review_task',
  'create_pr_for_task',
  'accept_review_task',
  'ship_feature',
  'complete_task',
  'archive_task'
] as const satisfies readonly PmProposalKind[];
```

- [ ] **Step 2: Write the failing store test**

Create `src/main/kanban/__tests__/pm-proposals-store.test.ts`:

```typescript
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { KanbanStore } from '../kanban-store';

function makeStore(): KanbanStore {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-proposals-'));
  return new KanbanStore(join(dir, 'kanban.db'), { now: () => 1000 });
}

describe('pm_proposals store', () => {
  it('creates, lists pending, and resolves a proposal', () => {
    const store = makeStore();
    const p = store.createProposal({
      boardId: 'b1',
      kind: 'complete_task',
      targetId: 't1',
      rationale: 'all subtasks done'
    });
    expect(p.status).toBe('pending');
    expect(p.error).toBeNull();
    expect(p.resolvedAt).toBeNull();

    expect(store.listProposals('b1', { status: 'pending' })).toHaveLength(1);

    store.resolveProposal(p.id, 'accepted', null);
    const after = store.getProposal(p.id);
    expect(after?.status).toBe('accepted');
    expect(after?.resolvedAt).toBe(1000);
    expect(store.listProposals('b1', { status: 'pending' })).toHaveLength(0);
  });

  it('records the error when a proposal fails', () => {
    const store = makeStore();
    const p = store.createProposal({
      boardId: 'b1',
      kind: 'merge_review_task',
      targetId: 't9',
      rationale: 'ready to merge'
    });
    store.resolveProposal(p.id, 'failed', 'merge conflict against main');
    expect(store.getProposal(p.id)?.error).toBe('merge conflict against main');
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npx vitest run src/main/kanban/__tests__/pm-proposals-store.test.ts`
Expected: FAIL — `store.createProposal is not a function`.

- [ ] **Step 4: Add the table DDL + bump schema version**

In `src/main/kanban/schema.ts`, change line 1 `SCHEMA_VERSION` from `15` to `16`. After the `feature_suggestions` block (~line 189) add:

```sql
CREATE TABLE IF NOT EXISTS pm_proposals (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proposals_board ON pm_proposals(board_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON pm_proposals(status);
```

`SCHEMA_SQL` runs with `CREATE TABLE IF NOT EXISTS`, so existing DBs pick the table up on next open; no explicit migration branch is needed for a brand-new table.

- [ ] **Step 5: Add store accessors**

In `src/main/kanban/kanban-store.ts`, after the feature-suggestion accessors (~line 1656) add (import `randomUUID` is already used in the file):

```typescript
createProposal(input: {
  boardId: string;
  kind: PmProposalKind;
  targetId: string;
  rationale: string;
}): PmProposal {
  const id = randomUUID().slice(0, 8);
  const ts = this.now();
  this.db
    .prepare(
      `INSERT INTO pm_proposals (id, board_id, kind, target_id, rationale, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(id, input.boardId, input.kind, input.targetId, input.rationale, ts);
  const p = this.getProposal(id);
  if (!p) throw new Error('createProposal: failed to read back proposal');
  return p;
}

getProposal(id: string): PmProposal | null {
  const row = this.db.prepare('SELECT * FROM pm_proposals WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? this.rowToProposal(row) : null;
}

listProposals(
  boardId: string,
  filter: { status?: PmProposalStatus } = {}
): PmProposal[] {
  const where = ['board_id=@boardId'];
  const params: Record<string, unknown> = { boardId };
  if (filter.status) {
    where.push('status=@status');
    params.status = filter.status;
  }
  const rows = this.db
    .prepare(`SELECT * FROM pm_proposals WHERE ${where.join(' AND ')} ORDER BY created_at DESC`)
    .all(params) as Array<Record<string, unknown>>;
  return rows.map((r) => this.rowToProposal(r));
}

resolveProposal(id: string, status: PmProposalStatus, error: string | null): void {
  this.db
    .prepare('UPDATE pm_proposals SET status=?, error=?, resolved_at=? WHERE id=?')
    .run(status, error, this.now(), id);
}

private rowToProposal(r: Record<string, unknown>): PmProposal {
  return {
    id: String(r.id),
    boardId: String(r.board_id),
    kind: r.kind as PmProposalKind,
    targetId: String(r.target_id),
    rationale: String(r.rationale ?? ''),
    status: r.status as PmProposalStatus,
    error: (r.error as string | null) ?? null,
    createdAt: Number(r.created_at),
    resolvedAt: (r.resolved_at as number | null) ?? null
  };
}
```

Add `PmProposal`, `PmProposalKind`, `PmProposalStatus` to the existing `import type { ... } from '../../shared/kanban-types'` at the top of `kanban-store.ts`.

- [ ] **Step 6: Run the test, verify it passes**

Run: `npx vitest run src/main/kanban/__tests__/pm-proposals-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: no new errors.

```bash
git add src/shared/kanban-types.ts src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/main/kanban/__tests__/pm-proposals-store.test.ts
git commit -m "feat(kanban): add pm_proposals table + store accessors"
```

---

### Task 2: `boards` digest-config columns + store accessors

**Files:**
- Modify: `src/shared/kanban-types.ts` (add `BoardDigestConfig`)
- Modify: `src/main/kanban/schema.ts` (`boards` columns added via migration — additive)
- Modify: `src/main/kanban/kanban-store.ts` (migration branch + accessors)
- Test: `src/main/kanban/__tests__/board-digest-config.test.ts` (new)

Note: `boards` columns must be added through the `user_version` migration path (the table already exists in old DBs), unlike the brand-new `pm_proposals` table.

- [ ] **Step 1: Add the shared type**

In `src/shared/kanban-types.ts`:

```typescript
export interface BoardDigestConfig {
  /** Cron expression for the standup digest, or null = off. */
  digestCron: string | null;
  /** Epoch ms of the last successful digest, or null = never. */
  lastDigestAt: number | null;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/main/kanban/__tests__/board-digest-config.test.ts`:

```typescript
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KanbanStore } from '../kanban-store';

function makeStore(now = () => 5000): KanbanStore {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-digest-cfg-'));
  return new KanbanStore(join(dir, 'kanban.db'), { now });
}

describe('board digest config', () => {
  it('defaults to no cron and no watermark', () => {
    const store = makeStore();
    store.ensureBoard('b1');
    expect(store.getDigestConfig('b1')).toEqual({ digestCron: null, lastDigestAt: null });
  });

  it('sets the cron and stamps the watermark', () => {
    const store = makeStore();
    store.ensureBoard('b1');
    store.setDigestCron('b1', '0 9 * * *');
    expect(store.getDigestConfig('b1').digestCron).toBe('0 9 * * *');
    store.stampLastDigest('b1');
    expect(store.getDigestConfig('b1').lastDigestAt).toBe(5000);
  });
});
```

If the store has no `ensureBoard`, replace those calls with whatever the store uses to materialize a board row (check `kanban-store.ts` for `ensureBoard`/`createBoard`/`upsertBoard`; mirror an existing board-creating test). Adjust the test before running.

- [ ] **Step 3: Run the test, verify it fails**

Run: `npx vitest run src/main/kanban/__tests__/board-digest-config.test.ts`
Expected: FAIL — `store.getDigestConfig is not a function`.

- [ ] **Step 4: Add the migration**

In `src/main/kanban/schema.ts` bump `SCHEMA_VERSION` to `17`. In `kanban-store.ts` `migrate()`, add a versioned branch following the existing `addColumnIfMissing` pattern:

```typescript
if (current < 17) {
  this.addColumnIfMissing('boards', 'digest_cron', 'TEXT');
  this.addColumnIfMissing('boards', 'last_digest_at', 'INTEGER');
}
```

(Confirm the exact column-add helper name by reading the `migrate()` body; the explore confirmed `addColumnIfMissing('tasks', ...)` is the pattern.)

- [ ] **Step 5: Add accessors**

In `kanban-store.ts`:

```typescript
getDigestConfig(boardId: string): BoardDigestConfig {
  const row = this.db
    .prepare('SELECT digest_cron, last_digest_at FROM boards WHERE id=?')
    .get(boardId) as { digest_cron: string | null; last_digest_at: number | null } | undefined;
  return {
    digestCron: row?.digest_cron ?? null,
    lastDigestAt: row?.last_digest_at ?? null
  };
}

setDigestCron(boardId: string, cron: string | null): void {
  this.db.prepare('UPDATE boards SET digest_cron=? WHERE id=?').run(cron, boardId);
}

stampLastDigest(boardId: string): void {
  this.db.prepare('UPDATE boards SET last_digest_at=? WHERE id=?').run(this.now(), boardId);
}
```

Add `BoardDigestConfig` to the `kanban-types` import in `kanban-store.ts`. Confirm the `boards` primary key column is `id` (read the `boards` DDL); if it differs, adjust the `WHERE` clauses.

- [ ] **Step 6: Run the test, verify it passes**

Run: `npx vitest run src/main/kanban/__tests__/board-digest-config.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add src/shared/kanban-types.ts src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/main/kanban/__tests__/board-digest-config.test.ts
git commit -m "feat(kanban): add per-board digest cron + watermark columns"
```

---

### Task 3: Global `kanban.pm` settings block

**Files:**
- Modify: `src/shared/types.ts` (`KanbanSettings`, ~line 156)
- Modify: `src/shared/constants.ts` (`DEFAULT_SETTINGS.kanban`)
- Modify: `src/main/settings-store.ts` (merge logic in `get()`/`set()`)
- Test: extend an existing settings test if present, else inline-verify via typecheck

- [ ] **Step 1: Add the type**

In `src/shared/types.ts`, inside `KanbanSettings` add a sibling to `dispatcher`:

```typescript
pm: {
  /** Master switch for event-driven turns AND the standup digest. */
  autopilotEnabled: boolean;
  /** Minimum ms between event-driven PM turns per board. */
  eventMinGapMs: number;
  /** Coalescing window (ms): events within this window batch into one turn. */
  coalesceWindowMs: number;
};
```

- [ ] **Step 2: Add the defaults**

In `src/shared/constants.ts`, in `DEFAULT_SETTINGS.kanban` add:

```typescript
pm: {
  autopilotEnabled: false,
  eventMinGapMs: 30_000,
  coalesceWindowMs: 2_000
},
```

- [ ] **Step 3: Update settings-store merge logic**

In `src/main/settings-store.ts`, the `get()` merge (lines ~46-59) and `set()` merge (lines ~91-101) deep-merge persisted settings over defaults. Add `pm` to the `kanban` sub-merge so a persisted store missing `pm` falls back to defaults. Follow the exact shape used for `dispatcher` there (read those lines and mirror the spread for `pm`):

```typescript
kanban: {
  ...DEFAULT_SETTINGS.kanban,
  ...persisted.kanban,
  dispatcher: { ...DEFAULT_SETTINGS.kanban.dispatcher, ...persisted.kanban?.dispatcher },
  pm: { ...DEFAULT_SETTINGS.kanban.pm, ...persisted.kanban?.pm },
  notifications: { ...DEFAULT_SETTINGS.kanban.notifications, ...persisted.kanban?.notifications }
}
```

(Match the surrounding code's existing style — if it uses zod parsing rather than manual spreads, add `pm` to the zod schema with `.default(...)` instead. Read the file first.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors (the new required `pm` keys are satisfied by the default).

If a settings round-trip test exists (search `__tests__` for `settings`), add a case asserting `get().kanban.pm.autopilotEnabled === false` on a fresh store; run it.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts src/main/settings-store.ts
git commit -m "feat(kanban): add global kanban.pm autopilot settings"
```

---

## Phase B — Turn refactor

### Task 4: Extract `runTurn` + per-board turn queue + origin log

**Files:**
- Modify: `src/main/kanban/pm-chat-service.ts`
- Modify: `src/shared/kanban-types.ts` (add `PmTurnOrigin`)
- Test: `src/main/kanban/__tests__/pm-chat-service.test.ts` (extend existing — see explore for the harness)

The current `sendMessage` (lines 135-279) inlines the entire turn. Refactor so the body becomes `runTurn(boardId, prompt, origin)` and add a per-board serialization queue so event/digest turns can't run concurrently with a user turn, while a user turn jumps ahead of queued event turns.

- [ ] **Step 1: Add the origin type**

In `src/shared/kanban-types.ts`:

```typescript
export type PmTurnOrigin = 'user' | 'event' | 'digest';
```

- [ ] **Step 2: Write the failing test (queue serialization)**

Extend `src/main/kanban/__tests__/pm-chat-service.test.ts`. Use the existing `spawnMock` + `makeService` harness (shown in the explore reference). Add:

```typescript
import { EventEmitter } from 'events';

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void; pid: number } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void; pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.pid = 4242;
  return child;
}

describe('PmChatService turn queue', () => {
  it('serializes turns: a second turn waits for the first to finish', async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    spawnMock.mockImplementation(() => {
      const c = fakeChild();
      children.push(c);
      return c;
    });
    const svc = makeService({});

    void svc.runTurn('b1', 'first', 'user');
    await Promise.resolve();
    expect(children).toHaveLength(1); // first turn spawned

    const second = svc.runTurn('b1', 'second', 'event');
    await Promise.resolve();
    expect(children).toHaveLength(1); // second is queued, NOT spawned yet

    children[0].emit('exit', 0, null); // finish the first turn
    await second;
    expect(children).toHaveLength(2); // now the second turn ran
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npx vitest run src/main/kanban/__tests__/pm-chat-service.test.ts -t "turn queue"`
Expected: FAIL — `svc.runTurn is not a function`.

- [ ] **Step 4: Refactor to `runTurn` + queue**

In `pm-chat-service.ts`:

(a) Add to the `BoardChat` interface a queue and add an origin log path. Replace the interface:

```typescript
interface QueuedTurn {
  prompt: string;
  origin: PmTurnOrigin;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface BoardChat {
  sessionId: string | null;
  inFlight: boolean;
  error: string | null;
  queue: QueuedTurn[];
}
```

Update the two `BoardChat` literals (lines 87 and 96) to include `queue: []`.

(b) Replace `sendMessage` with a thin wrapper plus the queue machinery:

```typescript
sendMessage(boardId: string, text: string): void {
  const body = text.trim();
  if (body === '') throw new CodedError('message is empty', 'BAD_REQUEST');
  // User turns jump ahead of any queued event/digest turns (human input is priority).
  void this.enqueueTurn(boardId, body, 'user', /* front */ true);
}

/** Public entry point for event- and digest-driven turns (PmAutopilot). */
runTurn(boardId: string, prompt: string, origin: PmTurnOrigin): Promise<void> {
  const body = prompt.trim();
  if (body === '') return Promise.resolve();
  return this.enqueueTurn(boardId, body, origin, /* front */ false);
}

private enqueueTurn(
  boardId: string,
  prompt: string,
  origin: PmTurnOrigin,
  front: boolean
): Promise<void> {
  const c = this.chat(boardId);
  return new Promise<void>((resolve, reject) => {
    const item: QueuedTurn = { prompt, origin, resolve, reject };
    if (front) c.queue.unshift(item);
    else c.queue.push(item);
    this.pump(boardId);
  });
}

private pump(boardId: string): void {
  const c = this.chat(boardId);
  if (c.inFlight) return;
  const next = c.queue.shift();
  if (!next) return;
  this.startTurn(boardId, next);
}
```

(c) Rename the existing `sendMessage` body to `private startTurn(boardId: string, turn: QueuedTurn): void`. Inside it:
- Use `turn.prompt` instead of `body`, `turn.origin` for the origin log.
- Drop the early `if (c.inFlight) throw` guard (the queue guarantees single-flight now).
- In the `finish(error)` callback, after the existing cleanup, append: record the origin, settle the queued promise, and pump the next turn:

```typescript
// (inside finish, after c.error = error; and the sessionId persistence block)
this.appendOriginLog(boardId, turn.origin, this.opts /* timestamp via Date.now */);
if (error) turn.reject(new Error(error));
else turn.resolve();
this.pump(boardId);
```

Note: `sendMessage` no longer surfaces synchronous setup errors to its caller (it returns void and the turn is async). Keep the synchronous-empty-string check in `sendMessage`. The renderer already reacts to `emitStatus({status:'error'})`, so setup failures still surface there.

(d) Add the origin-log writer (sidecar next to `pm-sessions.json`):

```typescript
private originLogPath(): string {
  return join(this.opts.kanbanHome, 'pm', 'pm-turn-origins.json');
}

private appendOriginLog(boardId: string, origin: PmTurnOrigin): void {
  try {
    const path = this.originLogPath();
    let log: Array<{ boardId: string; origin: PmTurnOrigin; at: number }> = [];
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      if (Array.isArray(raw)) log = raw;
    } catch {
      // first write or unreadable — start fresh
    }
    log.push({ boardId, origin, at: Date.now() });
    if (log.length > 500) log = log.slice(-500); // bound the sidecar
    mkdirSync(join(this.opts.kanbanHome, 'pm'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(log));
    renameSync(tmp, path);
  } catch {
    // origin log is best-effort telemetry; never block a turn
  }
}
```

Simplify the `finish` call in (c) to `this.appendOriginLog(boardId, turn.origin);`.

- [ ] **Step 5: Run the queue test + existing tests**

Run: `npx vitest run src/main/kanban/__tests__/pm-chat-service.test.ts`
Expected: PASS — the new queue test and all pre-existing PM-chat tests. If a pre-existing test asserted that calling `sendMessage` while in-flight throws `'the PM is still responding'`, update it to assert the second turn queues instead (the new contract).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/shared/kanban-types.ts src/main/kanban/pm-chat-service.ts src/main/kanban/__tests__/pm-chat-service.test.ts
git commit -m "refactor(kanban): serialize PM turns via runTurn + per-board queue"
```

---

## Phase C — PmAutopilot coordinator

### Task 5: `PmAutopilot` class (filter, coalesce, min-gap, master gate)

**Files:**
- Create: `src/main/kanban/pm-autopilot.ts`
- Create: `src/main/kanban/__tests__/pm-autopilot.test.ts`

The coordinator is a pure-ish class: clock injected, `runTurn` injected, config read fresh each call. It owns timers for coalescing.

- [ ] **Step 1: Write the failing test**

Create `src/main/kanban/__tests__/pm-autopilot.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { PmAutopilot } from '../pm-autopilot';
import type { TaskEvent } from '../../../shared/kanban-types';

function evt(kind: string, taskId = 't1'): TaskEvent {
  return { id: 1, taskId, runId: null, kind, payload: null, createdAt: 0 };
}

function makeDeps(overrides: Partial<Parameters<typeof PmAutopilot.prototype.constructor>[0]> = {}) {
  let t = 0;
  const runTurn = vi.fn(() => Promise.resolve());
  const deps = {
    now: () => t,
    getConfig: () => ({ autopilotEnabled: true, eventMinGapMs: 30_000, coalesceWindowMs: 2_000 }),
    getBoardForTask: (_id: string) => 'b1',
    runTurn,
    buildBriefing: (events: TaskEvent[]) => `events: ${events.map((e) => e.kind).join(',')}`,
    log: () => {}
  };
  return { deps: { ...deps, ...overrides }, runTurn, advance: (ms: number) => (t += ms) };
}

describe('PmAutopilot event turns', () => {
  it('ignores events when autopilot is disabled', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps({ getConfig: () => ({ autopilotEnabled: false, eventMinGapMs: 30_000, coalesceWindowMs: 2_000 }) });
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('completed'));
    vi.runAllTimers();
    expect(runTurn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('ignores non-whitelisted event kinds', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps();
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('heartbeat'));
    pa.onEvent(evt('comment'));
    vi.runAllTimers();
    expect(runTurn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('coalesces a burst into one turn', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps();
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('completed', 'a'));
    pa.onEvent(evt('completed', 'b'));
    pa.onEvent(evt('blocked', 'c'));
    vi.advanceTimersByTime(2_000);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith('b1', expect.stringContaining('completed,completed,blocked'), 'event');
    vi.useRealTimers();
  });

  it('enforces the min-gap between turns', async () => {
    vi.useFakeTimers();
    const { deps, runTurn, advance } = makeDeps();
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('completed'));
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();
    expect(runTurn).toHaveBeenCalledTimes(1);

    // a second burst within the min-gap is deferred, not fired immediately
    advance(5_000); // 5s elapsed << 30s gap
    pa.onEvent(evt('blocked'));
    vi.advanceTimersByTime(2_000);
    expect(runTurn).toHaveBeenCalledTimes(1);

    // after the gap elapses it fires
    advance(30_000);
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(runTurn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/main/kanban/__tests__/pm-autopilot.test.ts`
Expected: FAIL — cannot find module `../pm-autopilot`.

- [ ] **Step 3: Implement `PmAutopilot`**

Create `src/main/kanban/pm-autopilot.ts`:

```typescript
import type { TaskEvent, PmTurnOrigin } from '../../shared/kanban-types';

/** Event kinds that warrant a PM event-turn (the actual appendEvent kind strings). */
const TRIGGER_KINDS = new Set([
  'completed',
  'blocked',
  'review_ready',
  'verify_failed',
  'gave_up',
  'feature_pr_ready'
]);

export interface PmAutopilotConfig {
  autopilotEnabled: boolean;
  eventMinGapMs: number;
  coalesceWindowMs: number;
}

export interface PmAutopilotDeps {
  now: () => number;
  getConfig: () => PmAutopilotConfig;
  /** Resolve the board a task belongs to, or null if it no longer exists. */
  getBoardForTask: (taskId: string) => string | null;
  /** Run a serialized PM turn (delegates to PmChatService.runTurn). */
  runTurn: (boardId: string, prompt: string, origin: PmTurnOrigin) => Promise<void>;
  /** Build the turn prompt from a coalesced batch of events. */
  buildBriefing: (events: TaskEvent[]) => string;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

interface BoardBatch {
  events: TaskEvent[];
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  /** When the next event turn is allowed to fire (min-gap watermark). */
  nextAllowedAt: number;
  gapTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Second consumer of KanbanStore.onEvent. Decides WHEN the PM takes an
 * event-driven turn: filters noise, coalesces bursts, enforces a per-board
 * min-gap, and delegates the actual turn to a single-flight runTurn.
 */
export class PmAutopilot {
  private batches = new Map<string, BoardBatch>();

  constructor(private readonly deps: PmAutopilotDeps) {}

  /** Wired as a second onEvent consumer. Never throws into the store. */
  onEvent(event: TaskEvent): void {
    try {
      if (!this.deps.getConfig().autopilotEnabled) return;
      if (!TRIGGER_KINDS.has(event.kind)) return;
      const boardId = this.deps.getBoardForTask(event.taskId);
      if (!boardId) return;
      this.buffer(boardId, event);
    } catch (err) {
      this.deps.log('pm-autopilot onEvent failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /** Cancel all pending timers (app shutdown). */
  dispose(): void {
    for (const b of this.batches.values()) {
      if (b.coalesceTimer) clearTimeout(b.coalesceTimer);
      if (b.gapTimer) clearTimeout(b.gapTimer);
    }
    this.batches.clear();
  }

  private batch(boardId: string): BoardBatch {
    let b = this.batches.get(boardId);
    if (!b) {
      b = { events: [], coalesceTimer: null, nextAllowedAt: 0, gapTimer: null };
      this.batches.set(boardId, b);
    }
    return b;
  }

  private buffer(boardId: string, event: TaskEvent): void {
    const b = this.batch(boardId);
    b.events.push(event);
    if (b.coalesceTimer) return; // a flush is already scheduled
    const { coalesceWindowMs } = this.deps.getConfig();
    b.coalesceTimer = setTimeout(() => {
      b.coalesceTimer = null;
      this.maybeFlush(boardId);
    }, coalesceWindowMs);
  }

  private maybeFlush(boardId: string): void {
    const b = this.batch(boardId);
    if (b.events.length === 0) return;
    const { eventMinGapMs } = this.deps.getConfig();
    const now = this.deps.now();
    if (now < b.nextAllowedAt) {
      // Inside the min-gap: defer the flush to the watermark (once).
      if (!b.gapTimer) {
        b.gapTimer = setTimeout(() => {
          b.gapTimer = null;
          this.maybeFlush(boardId);
        }, b.nextAllowedAt - now);
      }
      return;
    }
    const events = b.events;
    b.events = [];
    b.nextAllowedAt = now + eventMinGapMs;
    const prompt = this.deps.buildBriefing(events);
    void this.deps.runTurn(boardId, prompt, 'event').catch((err) => {
      this.deps.log('pm-autopilot turn failed', {
        boardId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/main/kanban/__tests__/pm-autopilot.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/main/kanban/pm-autopilot.ts src/main/kanban/__tests__/pm-autopilot.test.ts
git commit -m "feat(kanban): add PmAutopilot event-turn coordinator"
```

---

### Task 6: Wire `PmAutopilot` into the app + briefing builder

**Files:**
- Modify: `src/main/index.ts` (construct PmAutopilot; add to `onEvent`; dispose on shutdown)
- Modify: `src/main/kanban/pm-autopilot.ts` (export a `buildEventBriefing` helper)

- [ ] **Step 1: Add the briefing builder (pure function)**

Append to `src/main/kanban/pm-autopilot.ts`:

```typescript
/** Build a compact, structured event-turn prompt from a coalesced batch. */
export function buildEventBriefing(
  events: TaskEvent[],
  resolveTitle: (taskId: string) => string | null
): string {
  const lines = events.map((e) => {
    const title = resolveTitle(e.taskId);
    const label = title ? `${e.taskId} "${title}"` : e.taskId;
    return `- ${e.kind}: ${label}`;
  });
  return [
    'Board activity since your last turn (autopilot):',
    ...lines,
    '',
    'Triage this: unblock or reassign stuck work, arm decompose/specify where',
    'useful, and propose any merge/complete/archive that is clearly ready',
    '(use kanban_propose — those need human confirmation). Keep it brief.'
  ].join('\n');
}
```

- [ ] **Step 2: Construct and wire PmAutopilot in `index.ts`**

In `src/main/index.ts`, after `pmChat = new PmChatService({...})` (line ~1222), add:

```typescript
pmAutopilot = new PmAutopilot({
  now: Date.now,
  getConfig: () => settingsStore.get().kanban.pm,
  getBoardForTask: (taskId) => kanbanStore?.getTask(taskId)?.boardId ?? null,
  runTurn: (boardId, prompt, origin) => pmChat!.runTurn(boardId, prompt, origin),
  buildBriefing: (events) =>
    buildEventBriefing(events, (id) => kanbanStore?.getTask(id)?.title ?? null),
  log: (msg, meta) => log.warn(msg, meta ?? {})
});
```

Declare `let pmAutopilot: PmAutopilot | undefined;` with the other module-level kanban singletons, and add the imports:

```typescript
import { PmAutopilot, buildEventBriefing } from './kanban/pm-autopilot';
```

- [ ] **Step 3: Add to the `onEvent` consumer chain**

In the `KanbanStore` `onEvent` callback (lines 875-882), after `kanbanNotifier?.enqueue(event);` add:

```typescript
pmAutopilot?.onEvent(event);
```

`PmAutopilot` is constructed *after* the store today (store at 874, pmChat at 1207). Because `onEvent` only fires on later board mutations (not during construction), the `pmAutopilot?.` optional guard safely no-ops for any event between store open and autopilot construction.

- [ ] **Step 4: Dispose on shutdown**

Find where `pmChat?.dispose()` / dispatcher teardown happens (search `dispose()` in `index.ts`) and add `pmAutopilot?.dispose();` alongside.

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: succeeds (this is the integration smoke for main-process wiring).

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/main/kanban/pm-autopilot.ts
git commit -m "feat(kanban): wire PmAutopilot as a second onEvent consumer"
```

---

## Phase D — Authority tools & proposals

### Task 7: Safe auto-callable tools

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts` (`PM_TOOLS` ~303-468; `handlePmToolCall` ~691)
- Modify: `src/main/kanban/kanban-commands.ts` (confirm `requestDecompose`/`requestSpecify`/`assign`/`unblock`/`comment` are reachable from commands; add a `comment` passthrough if PM routing needs it)
- Test: `src/main/kanban/__tests__/kanban-mcp-pm-tools.test.ts` (new — or extend an existing MCP test)

Safe tools: `kanban_arm_decompose`, `kanban_arm_specify`, `kanban_unblock` (with optional guidance), `kanban_reassign`.

- [ ] **Step 1: Write the failing test**

Create `src/main/kanban/__tests__/kanban-mcp-pm-tools.test.ts`. Mirror any existing MCP-server test harness (search `__tests__` for `kanban-mcp`); if none, drive `handlePmToolCall` via a constructed `KanbanMcpServer` with a stub `KanbanCommands`. Minimal shape:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { KanbanMcpServer } from '../kanban-mcp-server';

function makeServer() {
  const commands = {
    requestDecompose: vi.fn(),
    requestSpecify: vi.fn(),
    unblock: vi.fn(),
    comment: vi.fn(),
    assign: vi.fn()
  };
  const store = { getTask: () => ({ boardId: 'b1' }) } as never;
  const server = new KanbanMcpServer(store, () => []);
  // @ts-expect-error test seam: inject stub commands
  server.commands = commands;
  return { server, commands };
}
```

Then assert (using whatever public seam the existing tests use to invoke a tool — e.g. a `callPmTool(name, args, scope)` test helper if present; otherwise call `handlePmToolCall` via a thin exported test method). The behavioral assertions:

```typescript
describe('PM safe tools', () => {
  it('kanban_arm_decompose routes to requestDecompose', () => {
    const { server, commands } = makeServer();
    server.callPmToolForTest('kanban_arm_decompose', { task_id: 't1' }, { kind: 'board', boardId: 'b1' });
    expect(commands.requestDecompose).toHaveBeenCalledWith('t1');
  });

  it('kanban_unblock with guidance comments then unblocks', () => {
    const { server, commands } = makeServer();
    server.callPmToolForTest('kanban_unblock', { task_id: 't1', guidance: 'use the new API' }, { kind: 'board', boardId: 'b1' });
    expect(commands.comment).toHaveBeenCalledWith('t1', expect.stringContaining('use the new API'));
    expect(commands.unblock).toHaveBeenCalledWith('t1');
  });

  it('kanban_reassign routes to assign', () => {
    const { server, commands } = makeServer();
    server.callPmToolForTest('kanban_reassign', { task_id: 't1', profile: 'backend' }, { kind: 'board', boardId: 'b1' });
    expect(commands.assign).toHaveBeenCalledWith('t1', 'backend');
  });
});
```

If the existing MCP server has no public test seam, add a small one:

```typescript
/** Test-only: invoke a PM tool synchronously without the HTTP layer. */
callPmToolForTest(name: string, args: Record<string, unknown>, scope: BoardScope): void {
  this.execPmTool(scope, name, args);
}
```

…and refactor `handlePmToolCall`'s `switch` body into a private `execPmTool(scope, name, args)` that returns the text/throws, with `handlePmToolCall` wrapping it in the RPC envelope. (This refactor also keeps the proposal logic in Task 8 testable.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/main/kanban/__tests__/kanban-mcp-pm-tools.test.ts`
Expected: FAIL — unknown tool `kanban_arm_decompose`.

- [ ] **Step 3: Add the tool definitions**

In `PM_TOOLS` (kanban-mcp-server.ts ~line 303), append:

```typescript
{
  name: 'kanban_arm_decompose',
  description: 'Flag a task for the dispatcher to break into subtasks on its next tick.',
  inputSchema: {
    type: 'object',
    properties: { task_id: { type: 'string' } },
    required: ['task_id']
  }
},
{
  name: 'kanban_arm_specify',
  description: 'Flag a task for the dispatcher to write a detailed spec on its next tick.',
  inputSchema: {
    type: 'object',
    properties: { task_id: { type: 'string' } },
    required: ['task_id']
  }
},
{
  name: 'kanban_unblock',
  description: 'Return a blocked task to ready. Optionally attach guidance as a comment for the next run.',
  inputSchema: {
    type: 'object',
    properties: { task_id: { type: 'string' }, guidance: { type: 'string' } },
    required: ['task_id']
  }
},
{
  name: 'kanban_reassign',
  description: 'Reassign a task to a different worker profile by name.',
  inputSchema: {
    type: 'object',
    properties: { task_id: { type: 'string' }, profile: { type: 'string' } },
    required: ['task_id', 'profile']
  }
}
```

- [ ] **Step 4: Route the tools in `execPmTool`**

Add cases (validate args with the existing per-tool arg pattern in the file — read how other cases coerce `args.task_id`; mirror it, using zod if the file uses zod, else `String(args.task_id)` with a presence check as the surrounding cases do):

```typescript
case 'kanban_arm_decompose': {
  const taskId = requireStringArg(args, 'task_id');
  commands.requestDecompose(taskId);
  return `armed decompose for ${taskId}`;
}
case 'kanban_arm_specify': {
  const taskId = requireStringArg(args, 'task_id');
  commands.requestSpecify(taskId);
  return `armed specify for ${taskId}`;
}
case 'kanban_unblock': {
  const taskId = requireStringArg(args, 'task_id');
  const guidance = typeof args.guidance === 'string' ? args.guidance.trim() : '';
  if (guidance) commands.comment(taskId, `PM guidance: ${guidance}`);
  commands.unblock(taskId);
  return `unblocked ${taskId}`;
}
case 'kanban_reassign': {
  const taskId = requireStringArg(args, 'task_id');
  const profile = requireStringArg(args, 'profile');
  commands.assign(taskId, profile);
  return `reassigned ${taskId} to ${profile}`;
}
```

Use the file's existing argument-extraction helper rather than inventing `requireStringArg` if one exists; if not, add a tiny local helper near the top of the method:

```typescript
const requireStringArg = (a: Record<string, unknown>, key: string): string => {
  const v = a[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`missing or invalid "${key}"`);
  }
  return v;
};
```

Confirm `commands.comment(taskId, body)` exists (the `kanban_comment` tool routes to it). If the method is named differently (e.g. `addComment`), use that name.

- [ ] **Step 5: Run the test, verify it passes**

Run: `npx vitest run src/main/kanban/__tests__/kanban-mcp-pm-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/main/kanban/kanban-mcp-server.ts src/main/kanban/__tests__/kanban-mcp-pm-tools.test.ts
git commit -m "feat(kanban): add PM safe authority tools (arm/unblock/reassign)"
```

---

### Task 8: `kanban_propose` tool + `set_status` guardrail

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts` (`PM_TOOLS`, `execPmTool`)
- Modify: `src/main/kanban/kanban-commands.ts` (add `proposeAction(boardId, kind, targetId, rationale)` passthrough to `store.createProposal`)
- Test: extend `src/main/kanban/__tests__/kanban-mcp-pm-tools.test.ts`

- [ ] **Step 1: Add the commands passthrough**

In `kanban-commands.ts` add (near the suggestion methods):

```typescript
proposeAction(
  boardId: string,
  kind: PmProposalKind,
  targetId: string,
  rationale: string
): PmProposal {
  this.requireTask(targetId); // ship_feature targets a feature; see note below
  return this.store.createProposal({ boardId, kind, targetId, rationale });
}
```

Note: `requireTask` rejects a feature id. For `ship_feature`, skip the task check:

```typescript
proposeAction(boardId, kind, targetId, rationale): PmProposal {
  if (kind !== 'ship_feature') this.requireTask(targetId);
  return this.store.createProposal({ boardId, kind, targetId, rationale });
}
```

Import `PmProposal`, `PmProposalKind`, `PM_PROPOSAL_KINDS` into `kanban-commands.ts`.

- [ ] **Step 2: Write the failing test**

Add to `kanban-mcp-pm-tools.test.ts`:

```typescript
describe('PM propose + guardrail', () => {
  it('kanban_propose writes a proposal via commands', () => {
    const { server, commands } = makeServer();
    commands.proposeAction = vi.fn(() => ({ id: 'p1' }));
    server.callPmToolForTest(
      'kanban_propose',
      { kind: 'complete_task', target_id: 't1', rationale: 'done' },
      { kind: 'board', boardId: 'b1' }
    );
    expect(commands.proposeAction).toHaveBeenCalledWith('b1', 'complete_task', 't1', 'done');
  });

  it('rejects an unknown proposal kind', () => {
    const { server } = makeServer();
    expect(() =>
      server.callPmToolForTest('kanban_propose', { kind: 'nuke', target_id: 't1', rationale: 'x' }, { kind: 'board', boardId: 'b1' })
    ).toThrow();
  });

  it('set_status to done on a worktree task is rejected', () => {
    const { server, commands } = makeServer();
    commands.getTaskForGuard = vi.fn(() => ({ workspaceKind: 'worktree' }));
    expect(() =>
      server.callPmToolForTest('kanban_set_status', { task_id: 't1', status: 'done' }, { kind: 'board', boardId: 'b1' })
    ).toThrow(/propose/);
  });
});
```

(Adjust the guardrail assertion to however the server reads the task — see Step 4.)

- [ ] **Step 3: Add the `kanban_propose` tool definition**

In `PM_TOOLS`:

```typescript
{
  name: 'kanban_propose',
  description:
    'Propose a risky or irreversible board action for the human to confirm (Approve/Dismiss). ' +
    'Use for merges, opening PRs, completing, shipping a feature, or archiving — never act on these directly. ' +
    'kind is one of: merge_review_task, create_pr_for_task, accept_review_task, ship_feature, complete_task, archive_task. ' +
    'target_id is the task id (or feature id for ship_feature).',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      target_id: { type: 'string' },
      rationale: { type: 'string' }
    },
    required: ['kind', 'target_id', 'rationale']
  }
}
```

- [ ] **Step 4: Route it + add the guardrail in `execPmTool`**

```typescript
case 'kanban_propose': {
  const kind = requireStringArg(args, 'kind');
  if (!PM_PROPOSAL_KINDS.includes(kind as PmProposalKind)) {
    throw new Error(`invalid proposal kind: ${kind}`);
  }
  const targetId = requireStringArg(args, 'target_id');
  const rationale = requireStringArg(args, 'rationale');
  const p = commands.proposeAction(scope.boardId, kind as PmProposalKind, targetId, rationale);
  return `proposed ${kind} for ${targetId} (awaiting confirmation, id ${p.id})`;
}
```

In the existing `kanban_set_status` case, before calling `setManualStatus`, add the guardrail:

```typescript
if (status === 'done') {
  const task = this.store.getTask(taskId);
  if (task?.workspaceKind === 'worktree') {
    throw new Error(
      'worktree-backed tasks cannot be set done directly; use kanban_propose with merge_review_task or accept_review_task'
    );
  }
}
```

Import `PM_PROPOSAL_KINDS`, `PmProposalKind` into `kanban-mcp-server.ts`.

- [ ] **Step 5: Run the test, verify it passes**

Run: `npx vitest run src/main/kanban/__tests__/kanban-mcp-pm-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/main/kanban/kanban-mcp-server.ts src/main/kanban/kanban-commands.ts src/main/kanban/__tests__/kanban-mcp-pm-tools.test.ts
git commit -m "feat(kanban): add kanban_propose tool + worktree set_status guardrail"
```

---

### Task 9: Proposal IPC + deterministic execution on Approve

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts` (add `listProposals`, `resolveProposal` executor)
- Modify: `src/main/kanban/kanban-ipc.ts` (3 handlers)
- Modify: `src/shared/ipc-channels.ts`, `src/shared/ipc-api.ts`, `src/renderer/src/ipc-api.ts`
- Test: `src/main/kanban/__tests__/proposal-executor.test.ts` (new)

- [ ] **Step 1: Write the failing executor test**

Create `src/main/kanban/__tests__/proposal-executor.test.ts`. The executor maps a proposal kind to a command and marks the row accepted/failed:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { executeProposal } from '../proposal-executor';

function commandsStub() {
  return {
    mergeReviewTask: vi.fn(() => ({ ok: true })),
    createPrForTask: vi.fn(() => ({ ok: true })),
    acceptReviewTask: vi.fn(() => ({ ok: true })),
    shipFeature: vi.fn(() => ({ ok: true })),
    complete: vi.fn(),
    archive: vi.fn()
  };
}

describe('executeProposal', () => {
  it('runs complete_task via commands.complete', () => {
    const c = commandsStub();
    executeProposal(c as never, { kind: 'complete_task', targetId: 't1' } as never);
    expect(c.complete).toHaveBeenCalledWith('t1', expect.any(String));
  });

  it('runs merge_review_task via commands.mergeReviewTask', () => {
    const c = commandsStub();
    executeProposal(c as never, { kind: 'merge_review_task', targetId: 't2' } as never);
    expect(c.mergeReviewTask).toHaveBeenCalledWith('t2');
  });

  it('throws when a review action returns ok:false', () => {
    const c = commandsStub();
    c.mergeReviewTask = vi.fn(() => ({ ok: false, error: 'conflict' }));
    expect(() =>
      executeProposal(c as never, { kind: 'merge_review_task', targetId: 't3' } as never)
    ).toThrow('conflict');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/main/kanban/__tests__/proposal-executor.test.ts`
Expected: FAIL — cannot find `../proposal-executor`.

- [ ] **Step 3: Implement the executor**

Create `src/main/kanban/proposal-executor.ts`:

```typescript
import type { KanbanCommands } from './kanban-commands';
import type { PmProposal } from '../../shared/kanban-types';

/**
 * Deterministically run an approved proposal through KanbanCommands. Throws on
 * failure (caller marks the proposal 'failed' with the message). Review actions
 * return { ok, error } rather than throwing, so we normalize those to a throw.
 */
export function executeProposal(
  commands: KanbanCommands,
  proposal: Pick<PmProposal, 'kind' | 'targetId'>
): void {
  const { kind, targetId } = proposal;
  const expectOk = (r: { ok: boolean; error?: string; conflict?: boolean }): void => {
    if (!r.ok) throw new Error(r.error ?? (r.conflict ? 'merge conflict' : 'action failed'));
  };
  switch (kind) {
    case 'merge_review_task':
      return expectOk(commands.mergeReviewTask(targetId));
    case 'create_pr_for_task':
      return expectOk(commands.createPrForTask(targetId));
    case 'accept_review_task':
      return expectOk(commands.acceptReviewTask(targetId));
    case 'ship_feature':
      return expectOk(commands.shipFeature(targetId));
    case 'complete_task':
      return commands.complete(targetId, 'completed via PM proposal');
    case 'archive_task':
      return commands.archive(targetId);
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown proposal kind: ${String(exhaustive)}`);
    }
  }
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run src/main/kanban/__tests__/proposal-executor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add commands-level approve/dismiss/list**

In `kanban-commands.ts`:

```typescript
listProposals(boardId: string, status?: PmProposalStatus): PmProposal[] {
  return this.store.listProposals(boardId, status ? { status } : {});
}

approveProposal(id: string): PmProposal {
  const p = this.store.getProposal(id);
  if (!p) throw new CodedError('proposal not found', 'NOT_FOUND');
  if (p.status !== 'pending') throw new CodedError('proposal already resolved', 'BAD_REQUEST');
  try {
    executeProposal(this, p);
    this.store.resolveProposal(id, 'accepted', null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    this.store.resolveProposal(id, 'failed', msg);
  }
  const after = this.store.getProposal(id);
  if (!after) throw new Error('approveProposal: proposal vanished');
  return after;
}

dismissProposal(id: string): void {
  this.store.resolveProposal(id, 'dismissed', null);
}
```

Import `executeProposal` from `./proposal-executor` and `PmProposalStatus` into `kanban-commands.ts`.

- [ ] **Step 6: Add IPC channels, types, handlers, preload**

In `src/shared/ipc-channels.ts`:

```typescript
export const KANBAN_LIST_PROPOSALS = 'kanban:list-proposals';
export const KANBAN_APPROVE_PROPOSAL = 'kanban:approve-proposal';
export const KANBAN_DISMISS_PROPOSAL = 'kanban:dismiss-proposal';
```

In `src/shared/ipc-api.ts` add request types and extend the `window.fleet.kanban` interface:

```typescript
listProposals(boardId: string): Promise<PmProposal[]>;
approveProposal(id: string): Promise<PmProposal>;
dismissProposal(id: string): Promise<void>;
```

In `kanban-ipc.ts`:

```typescript
ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_PROPOSALS, (_e, boardId: string) =>
  commands.listProposals(boardId, 'pending')
);
ipcMain.handle(IPC_CHANNELS.KANBAN_APPROVE_PROPOSAL, (_e, id: string) =>
  commands.approveProposal(id)
);
ipcMain.handle(IPC_CHANNELS.KANBAN_DISMISS_PROPOSAL, (_e, id: string) =>
  commands.dismissProposal(id)
);
```

In `src/renderer/src/ipc-api.ts` add the three preload methods mirroring the existing `kanban.*` invoke pattern.

- [ ] **Step 7: Verify + commit**

Run: `npm run typecheck && npx vitest run src/main/kanban/__tests__/proposal-executor.test.ts`
Expected: PASS, no type errors.

```bash
git add src/main/kanban/proposal-executor.ts src/main/kanban/kanban-commands.ts src/main/kanban/kanban-ipc.ts src/shared/ipc-channels.ts src/shared/ipc-api.ts src/renderer/src/ipc-api.ts src/main/kanban/__tests__/proposal-executor.test.ts
git commit -m "feat(kanban): proposal approve/dismiss IPC + deterministic executor"
```

---

### Task 10: Proposal cards in PM chat (renderer)

**Files:**
- Modify: `src/renderer/src/components/kanban/PmChat.tsx` (confirm exact path with `grep -rl "learnings.pm\|KANBAN_PM_TRANSCRIPT\|sendMessage" src/renderer`)

Pure UI; verified by typecheck + manual smoke (no renderer unit-test harness in this repo for chat).

- [ ] **Step 1: Fetch + render pending proposals**

In the PM chat component, add state and a fetch on mount + on `KANBAN_PM_TRANSCRIPT`/event refresh:

```typescript
const [proposals, setProposals] = useState<PmProposal[]>([]);
const refreshProposals = useCallback(async () => {
  setProposals(await window.fleet.kanban.listProposals(boardId));
}, [boardId]);
useEffect(() => { void refreshProposals(); }, [refreshProposals]);
```

Render each pending proposal as a card above the composer:

```tsx
{proposals.map((p) => (
  <div key={p.id} className="rounded border border-fleet-border bg-fleet-surface-2/40 px-3 py-2 text-sm">
    <div className="text-fleet-text">
      <span className="font-medium">{p.kind.replace(/_/g, ' ')}</span> · {p.targetId}
    </div>
    <div className="text-xs text-fleet-text-subtle">{p.rationale}</div>
    <div className="mt-2 flex gap-2">
      <button
        className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
        onClick={async () => { await window.fleet.kanban.approveProposal(p.id); await refreshProposals(); }}
      >
        Approve
      </button>
      <button
        className="rounded border border-fleet-border-strong px-2 py-1 text-xs text-fleet-text-subtle hover:bg-fleet-surface-2/50"
        onClick={async () => { await window.fleet.kanban.dismissProposal(p.id); await refreshProposals(); }}
      >
        Dismiss
      </button>
    </div>
  </div>
))}
```

After Approve, if the returned proposal `status === 'failed'`, surface `p.error` (e.g. a small red line under the card before it disappears on refresh — refetch and show failed proposals' error for one render, or toast it).

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: no new errors (lint is pre-existing-red; confirm count unchanged via `git stash` if unsure).

```bash
git add src/renderer/src/components/kanban/PmChat.tsx
git commit -m "feat(kanban): render PM proposal Approve/Dismiss cards"
```

---

## Phase E — Standup digest

### Task 11: Digest-context builder + store time-range queries

**Files:**
- Create: `src/main/kanban/pm-digest.ts`
- Create: `src/main/kanban/__tests__/pm-digest.test.ts`
- Modify: `src/main/kanban/kanban-store.ts` (add `listBoardEventsSince(boardId, since)`)

- [ ] **Step 1: Add a board-scoped event query to the store**

`task_events` has no `board_id` column, so join through `tasks`. Add to `kanban-store.ts`:

```typescript
/** All events for a board's tasks since `since` (epoch ms), oldest first. */
listBoardEventsSince(boardId: string, since: number): TaskEvent[] {
  const rows = this.db
    .prepare(
      `SELECT e.* FROM task_events e
         JOIN tasks t ON t.id = e.task_id
        WHERE t.board_id = ? AND e.created_at >= ?
        ORDER BY e.id ASC`
    )
    .all(boardId, since) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    taskId: String(r.task_id),
    runId: (r.run_id as number | null) ?? null,
    kind: String(r.kind),
    payload: r.payload ? (JSON.parse(String(r.payload)) as Record<string, unknown>) : null,
    createdAt: Number(r.created_at)
  }));
}
```

Confirm `tasks` has a `board_id` column (it does — `getTask` returns `boardId`; check the DDL for the exact name).

- [ ] **Step 2: Write the failing digest test**

Create `src/main/kanban/__tests__/pm-digest.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildDigestContext } from '../pm-digest';
import type { TaskEvent } from '../../../shared/kanban-types';

function evt(kind: string, taskId: string): TaskEvent {
  return { id: 1, taskId, runId: null, kind, payload: null, createdAt: 0 };
}

describe('buildDigestContext', () => {
  it('buckets events into completed / blocked / failures and counts proposals', () => {
    const ctx = buildDigestContext({
      events: [
        evt('completed', 'a'),
        evt('completed', 'b'),
        evt('blocked', 'c'),
        evt('verify_failed', 'd'),
        evt('gave_up', 'd')
      ],
      pendingProposals: 2,
      resolveTitle: (id) => `task ${id}`
    });
    expect(ctx).toContain('Completed (2)');
    expect(ctx).toContain('Blocked (1)');
    expect(ctx).toContain('Failures (2)');
    expect(ctx).toContain('2 proposal');
  });

  it('reports a quiet board', () => {
    const ctx = buildDigestContext({ events: [], pendingProposals: 0, resolveTitle: () => null });
    expect(ctx).toContain('No board activity');
  });
});
```

- [ ] **Step 3: Run, verify it fails**

Run: `npx vitest run src/main/kanban/__tests__/pm-digest.test.ts`
Expected: FAIL — cannot find `../pm-digest`.

- [ ] **Step 4: Implement the builder**

Create `src/main/kanban/pm-digest.ts`:

```typescript
import type { TaskEvent } from '../../shared/kanban-types';

const COMPLETED = new Set(['completed', 'merged', 'accepted']);
const BLOCKED = new Set(['blocked']);
const FAILURES = new Set(['verify_failed', 'gave_up', 'spawn_failed', 'merge_failed', 'pr_failed']);

export interface DigestInput {
  events: TaskEvent[];
  pendingProposals: number;
  resolveTitle: (taskId: string) => string | null;
}

/** Build the standup-digest prompt from activity since the last digest. */
export function buildDigestContext(input: DigestInput): string {
  const { events, pendingProposals, resolveTitle } = input;
  const pick = (set: Set<string>): string[] => {
    const ids = new Set(events.filter((e) => set.has(e.kind)).map((e) => e.taskId));
    return [...ids].map((id) => {
      const t = resolveTitle(id);
      return t ? `${id} "${t}"` : id;
    });
  };
  const completed = pick(COMPLETED);
  const blocked = pick(BLOCKED);
  const failures = pick(FAILURES);

  if (events.length === 0 && pendingProposals === 0) {
    return 'No board activity since the last standup. Give a one-line all-quiet note.';
  }

  const lines: string[] = ['Board activity since the last standup:'];
  if (completed.length) lines.push(`- Completed (${completed.length}): ${completed.join(', ')}`);
  if (blocked.length) lines.push(`- Blocked (${blocked.length}): ${blocked.join(', ')}`);
  if (failures.length) lines.push(`- Failures (${failures.length}): ${failures.join(', ')}`);
  if (pendingProposals > 0) lines.push(`- ${pendingProposals} proposal(s) awaiting your confirmation.`);
  lines.push('', 'Write a short standup: what shipped, what is stuck, and what needs a human decision.');
  return lines.join('\n');
}
```

- [ ] **Step 5: Run, verify it passes**

Run: `npx vitest run src/main/kanban/__tests__/pm-digest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/main/kanban/pm-digest.ts src/main/kanban/kanban-store.ts src/main/kanban/__tests__/pm-digest.test.ts
git commit -m "feat(kanban): add standup digest context builder + event query"
```

---

### Task 12: Digest scheduling in PmAutopilot + watermark

**Files:**
- Modify: `src/main/kanban/pm-autopilot.ts` (cron check + `runDigestTurn`)
- Modify: `src/main/index.ts` (wire digest deps; drive the cron check from an existing periodic tick)
- Test: extend `src/main/kanban/__tests__/pm-autopilot.test.ts`

The dispatcher already runs a periodic tick (`intervalMs`). Rather than a new timer, expose `PmAutopilot.checkDigests()` and call it from the same interval that drives the dispatcher (or a dedicated `setInterval` in `index.ts` if cleaner — confirm the dispatcher loop location).

- [ ] **Step 1: Write the failing test**

Add to `pm-autopilot.test.ts`:

```typescript
import { isCronDue } from '../pm-autopilot';

describe('PmAutopilot digest', () => {
  it('fires a digest turn when cron is due and stamps the watermark', async () => {
    const runTurn = vi.fn(() => Promise.resolve());
    const stamp = vi.fn();
    const pa = new PmAutopilot({
      now: () => 0,
      getConfig: () => ({ autopilotEnabled: true, eventMinGapMs: 30_000, coalesceWindowMs: 2_000 }),
      getBoardForTask: () => 'b1',
      runTurn,
      buildBriefing: () => 'x',
      log: () => {},
      listDigestBoards: () => [{ boardId: 'b1', digestCron: '* * * * *', lastDigestAt: null }],
      buildDigest: () => 'standup please',
      stampDigest: stamp
    });
    await pa.checkDigests();
    expect(runTurn).toHaveBeenCalledWith('b1', 'standup please', 'digest');
    expect(stamp).toHaveBeenCalledWith('b1');
  });

  it('does not fire when autopilot is disabled', async () => {
    const runTurn = vi.fn(() => Promise.resolve());
    const pa = new PmAutopilot({
      now: () => 0,
      getConfig: () => ({ autopilotEnabled: false, eventMinGapMs: 30_000, coalesceWindowMs: 2_000 }),
      getBoardForTask: () => 'b1',
      runTurn,
      buildBriefing: () => 'x',
      log: () => {},
      listDigestBoards: () => [{ boardId: 'b1', digestCron: '* * * * *', lastDigestAt: null }],
      buildDigest: () => 'standup please',
      stampDigest: () => {}
    });
    await pa.checkDigests();
    expect(runTurn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/main/kanban/__tests__/pm-autopilot.test.ts -t digest`
Expected: FAIL — `pa.checkDigests is not a function`.

- [ ] **Step 3: Extend `PmAutopilotDeps` and add `checkDigests`**

In `pm-autopilot.ts`, extend `PmAutopilotDeps`. Mark these **optional** so the
event-turn tests from Task 5 (which construct `PmAutopilot` without digest deps)
still typecheck; `checkDigests` early-returns when they're absent:

```typescript
/** Boards with a digest cron configured + their watermark. */
listDigestBoards?: () => Array<{ boardId: string; digestCron: string | null; lastDigestAt: number | null }>;
buildDigest?: (boardId: string, since: number) => string;
stampDigest?: (boardId: string) => void;
```

Add a cron-due helper and the check. Use the repo's existing cron evaluator — the explore noted `schedule.ts` handles `cron` schedules; reuse its matcher. If it exposes a `cronMatches(expr, date)` / `nextCronAfter(expr, from)` function, import it; otherwise add a thin wrapper. Implementation:

```typescript
import { nextCronAfter } from './schedule'; // confirm the exported name in schedule.ts

/** True if `cron` should have fired between `lastAt` (exclusive) and `now`. */
export function isCronDue(cron: string, lastAt: number | null, now: number): boolean {
  const from = lastAt ?? now - 24 * 60 * 60 * 1000; // never run before → look back a day
  const next = nextCronAfter(cron, from);
  return next != null && next <= now;
}
```

```typescript
/** Fire any due digests. Call from the dispatcher's periodic tick. */
async checkDigests(): Promise<void> {
  try {
    const { listDigestBoards, buildDigest, stampDigest } = this.deps;
    if (!listDigestBoards || !buildDigest || !stampDigest) return; // digest not wired
    if (!this.deps.getConfig().autopilotEnabled) return;
    const now = this.deps.now();
    for (const b of listDigestBoards()) {
      if (!b.digestCron) continue;
      if (!isCronDue(b.digestCron, b.lastDigestAt, now)) continue;
      const since = b.lastDigestAt ?? now - 24 * 60 * 60 * 1000;
      const prompt = buildDigest(b.boardId, since);
      stampDigest(b.boardId); // stamp before the turn so a crash can't double-fire
      await this.deps.runTurn(b.boardId, prompt, 'digest').catch((err) =>
        this.deps.log('digest turn failed', {
          boardId: b.boardId,
          error: err instanceof Error ? err.message : String(err)
        })
      );
    }
  } catch (err) {
    this.deps.log('checkDigests failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
```

If `schedule.ts` exposes no reusable cron function, add a minimal `nextCronAfter` there (don't hand-roll a second cron parser elsewhere) and unit-test it separately. Confirm the exact API before importing.

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run src/main/kanban/__tests__/pm-autopilot.test.ts`
Expected: PASS (all PmAutopilot tests).

- [ ] **Step 5: Wire the digest deps + tick call in `index.ts`**

Extend the `new PmAutopilot({...})` deps:

```typescript
listDigestBoards: () => {
  const boards = kanbanCommands?.listBoards?.() ?? [];
  return boards.map((b) => {
    const cfg = kanbanStore!.getDigestConfig(b.slug ?? b.id);
    return { boardId: b.slug ?? b.id, digestCron: cfg.digestCron, lastDigestAt: cfg.lastDigestAt };
  });
},
buildDigest: (boardId, since) =>
  buildDigestContext({
    events: kanbanStore!.listBoardEventsSince(boardId, since),
    pendingProposals: kanbanStore!.listProposals(boardId, { status: 'pending' }).length,
    resolveTitle: (id) => kanbanStore?.getTask(id)?.title ?? null
  }),
stampDigest: (boardId) => kanbanStore!.stampLastDigest(boardId)
```

Import `buildDigestContext` from `./kanban/pm-digest`. Confirm how to enumerate boards (`kanbanCommands.listBoards()` or `kanbanStore.listBoards()` — grep for `listBoards`); use the canonical board identifier the rest of the kanban code keys on (slug vs id — match `getDigestConfig`'s expectation from Task 2).

Then call `void pmAutopilot?.checkDigests();` from inside the dispatcher's periodic interval callback (find it near the `kanbanDispatcher = new KanbanDispatcher` setup / its `setInterval`). The 1-minute-granularity cron + the stamp-before-run guard make piggybacking on the existing seconds/minutes tick safe.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npm run build`
Expected: succeeds.

```bash
git add src/main/kanban/pm-autopilot.ts src/main/index.ts src/main/kanban/__tests__/pm-autopilot.test.ts
git commit -m "feat(kanban): schedule standup digest turns via PmAutopilot"
```

---

### Task 13: Digest-cron UI control + IPC

**Files:**
- Modify: `src/shared/ipc-channels.ts`, `src/shared/ipc-api.ts`, `src/renderer/src/ipc-api.ts`
- Modify: `src/main/kanban/kanban-ipc.ts`, `src/main/kanban/kanban-commands.ts`
- Modify: PM chat / board settings component (the same component as Task 10, or a board-settings panel)

- [ ] **Step 1: Commands + IPC passthroughs**

In `kanban-commands.ts`:

```typescript
getDigestConfig(boardId: string): BoardDigestConfig {
  return this.store.getDigestConfig(boardId);
}
setDigestCron(boardId: string, cron: string | null): void {
  this.store.setDigestCron(boardId, cron);
}
```

In `ipc-channels.ts`: `KANBAN_GET_DIGEST_CONFIG`, `KANBAN_SET_DIGEST_CRON`. In `kanban-ipc.ts`, register two handlers. In `ipc-api.ts` + preload, add `getDigestConfig(boardId)` and `setDigestCron(boardId, cron)`.

- [ ] **Step 2: UI control**

In the PM chat (or board settings) component, add a small control:

```tsx
const [cron, setCron] = useState<string | null>(null);
useEffect(() => { void window.fleet.kanban.getDigestConfig(boardId).then((c) => setCron(c.digestCron)); }, [boardId]);

<label className="flex items-center gap-2 text-xs text-fleet-text-subtle">
  <input
    type="checkbox"
    checked={cron === '0 9 * * *'}
    onChange={async (e) => {
      const next = e.target.checked ? '0 9 * * *' : null;
      await window.fleet.kanban.setDigestCron(boardId, next);
      setCron(next);
    }}
  />
  Daily 9am standup digest
</label>
```

(A checkbox toggling the "daily 9am" preset is the only required surface; a free-form cron input is out of scope.)

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: no new errors.

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts src/renderer/src/ipc-api.ts src/main/kanban/kanban-ipc.ts src/main/kanban/kanban-commands.ts src/renderer/src/components/kanban/PmChat.tsx
git commit -m "feat(kanban): add daily-9am standup digest toggle"
```

---

### Task 14: PM persona autopilot mandate + settings UI

**Files:**
- Modify: `src/main/kanban/pm-agents.ts`
- Modify: `src/main/kanban/pm-chat-service.ts` (pass `autopilotEnabled` into `buildPmAgentsMd`)
- Modify: the kanban Settings UI component (where dispatcher knobs render — grep `autoDecompose` in `src/renderer`)

- [ ] **Step 1: Add the mandate section to the persona**

In `pm-agents.ts`, add a function and include it conditionally:

```typescript
function autopilotSection(enabled: boolean): string {
  if (!enabled) return '';
  return `
## Autopilot authority

You run on autopilot: you also wake on board events (a task completes, blocks,
fails verification, or a review is ready) and on a scheduled standup, not only
when the user types.

- Act directly on SAFE moves: kanban_unblock (add guidance if useful),
  kanban_reassign, kanban_arm_decompose, kanban_arm_specify.
- For RISKY or irreversible moves — merging, opening a PR, completing, shipping
  a feature, archiving — never act directly. Call kanban_propose(kind,
  target_id, rationale); the human approves or dismisses it.
- Never set a worktree-backed task to done directly; propose merge_review_task
  or accept_review_task instead.
- On an event turn, triage what changed and stop — don't re-survey the whole board.
`;
}

export function buildPmAgentsMd(input: {
  projects: Project[];
  memory: string | null;
  autopilotEnabled?: boolean;
}): string {
  return (
    PM_BASE +
    autopilotSection(input.autopilotEnabled ?? false) +
    projectsSection(input.projects) +
    memorySection(input.memory)
  );
}
```

- [ ] **Step 2: Pass the flag from pm-chat-service**

`PmChatServiceOptions` needs a way to read the flag. Add to the options interface:

```typescript
/** Whether PM autopilot is on (read fresh each turn) — injected into the persona. */
isAutopilotEnabled?: () => boolean;
```

In `startTurn`, change the `buildPmAgentsMd` call to:

```typescript
writeFileSync(
  join(dir, 'AGENTS.md'),
  buildPmAgentsMd({ projects, memory, autopilotEnabled: this.opts.isAutopilotEnabled?.() ?? false })
);
```

In `index.ts`, pass `isAutopilotEnabled: () => settingsStore.get().kanban.pm.autopilotEnabled` into the `PmChatService` constructor.

- [ ] **Step 3: Settings UI toggle**

In the kanban settings component (next to the dispatcher `autoDecompose`/`autoReview` toggles), add a checkbox bound to `kanban.pm.autopilotEnabled` using the existing settings-update pattern (mirror an adjacent dispatcher toggle exactly — same `updateSettings`/`onChange` handler shape). Label: "PM autopilot (event-driven turns + digest)".

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: succeeds; no new lint errors.

```bash
git add src/main/kanban/pm-agents.ts src/main/kanban/pm-chat-service.ts src/main/index.ts src/renderer/src/components/settings
git commit -m "feat(kanban): PM autopilot persona mandate + settings toggle"
```

---

## Final verification

- [ ] **Run the full check suite**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: typecheck clean; lint shows no NEW errors (pre-existing-red baseline only — verify count vs `main` if unsure); all vitest tests pass; build succeeds.

- [ ] **Manual smoke (with `pmAutopilotEnabled` on, a board with a worktree task)**
  1. Toggle PM autopilot on in settings.
  2. Let a task complete → confirm one coalesced PM event turn appears in chat (origin not "user").
  3. Have the PM propose a merge → confirm an Approve/Dismiss card renders; Approve runs the merge and the card clears; force a conflict → card shows `failed` with the error.
  4. Enable "Daily 9am standup digest" on a board; temporarily set the cron preset check to fire (or wait) → confirm a digest turn posts a standup.
  5. Toggle autopilot off → confirm event/digest turns stop and chat still works.

- [ ] **Commit any smoke fixes, then open the PR**

```bash
git push -u origin docs/pm-agent-upgrades-spec  # (work branch; rename if a feature branch is preferred)
gh pr create --base main --title "feat(kanban): PM agent upgrades — event turns, authority, digest (#233)" --body "$(cat <<'EOF'
## Summary
- PmAutopilot coordinator: event-driven PM turns (filter + coalesce + min-gap + single-flight)
- Bounded board authority: safe tools act directly; risky actions go through kanban_propose → human Approve/Dismiss
- Optional per-board standup digest (daily-9am preset)

Implements #233. Spec: docs/superpowers/specs/2026-06-15-pm-agent-upgrades-design.md

## Test plan
- [ ] typecheck + lint + vitest + build green
- [ ] manual smoke (event turn, proposal approve/fail, digest, toggle off)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes on spec coverage

- **§1 event-turn machinery** → Tasks 5, 6 (filter/coalesce/min-gap/master-gate/single-flight via runTurn).
- **§2 turn entry points + briefing + origin log + persona** → Tasks 4, 6, 14.
- **§3 authority tools + proposal model + guardrail** → Tasks 7, 8, 9, 10.
- **§4 standup digest** → Tasks 11, 12, 13.
- **Config surface** → Task 3 (global) + Task 2 (per-board digest).
- **Data model** → Task 1 (`pm_proposals`) + Task 2 (`boards` columns) + Task 4 (origin sidecar).
- **Testing/error-handling rollups** → covered per-task (try/catch in PmAutopilot Task 5; proposal `failed` path Task 9; queue serialization Task 4).
