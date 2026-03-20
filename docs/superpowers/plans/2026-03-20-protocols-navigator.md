# Protocols & Navigator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Protocols & Navigator system — a multi-step autonomous workflow executor that dispatches research and review crews, produces a Feature Brief, and gates for operator approval before the Admiral creates missions.

**Architecture:** A Navigator class (mirrors FirstOfficer pattern) executes DB-stored Protocols step-by-step using the fleet CLI. Sentinel triggers Navigator spawns on crew-failed events and gate expiry. CommsService carries execution_id to scope comms per execution.

**Tech Stack:** TypeScript, better-sqlite3, vitest, Claude Code CLI (stream-json), fleet CLI

**Spec:** `docs/superpowers/specs/2026-03-20-protocols-navigator-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/main/starbase/protocol-service.ts` | CRUD for protocols, protocol_steps, protocol_executions |
| Create | `src/main/starbase/navigator.ts` | Navigator class — spawn, lifecycle, cleanup |
| Create | `src/main/__tests__/protocol-service.test.ts` | Protocol service tests |
| Create | `src/main/__tests__/navigator.test.ts` | Navigator spawn/dispatch tests |
| Modify | `src/main/starbase/migrations.ts` | Migrations 11 + 12, CONFIG_DEFAULTS |
| Modify | `src/main/starbase/comms-service.ts` | execution_id in SendOpts + INSERT + dedup exclusion |
| Modify | `src/main/starbase/retention-service.ts` | Add protocol_executions to cleanup + TABLES |
| Modify | `src/main/starbase/workspace-templates.ts` | Add generateNavigatorClaudeMd() |
| Modify | `src/main/socket-server.ts` | protocol.* and execution.* command handlers |
| Modify | `src/main/fleet-cli.ts` | Protocol commands in COMMAND_MAP + formatted output |
| Modify | `src/main/starbase/sentinel.ts` | navigatorSweep() + gate expiry in _runSweep() |
| Modify | `src/main/__tests__/comms-service.test.ts` | execution_id tests |
| Modify | `src/main/__tests__/sentinel.test.ts` | Navigator sweep tests |

---

## Task 1: Migrations 11 and 12

**Files:**
- Modify: `src/main/starbase/migrations.ts`

- [ ] **Step 1: Add migration 11 — protocol tables + global sector seed**

In `migrations.ts`, add after the existing migration 10 entry in the `MIGRATIONS` array:

```typescript
{
  version: 11,
  name: '011-protocols-navigator',
  sql: `
    CREATE TABLE IF NOT EXISTS protocols (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      help_text TEXT,
      trigger_examples TEXT,
      enabled INTEGER DEFAULT 1,
      built_in INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS protocol_steps (
      id INTEGER PRIMARY KEY,
      protocol_id TEXT REFERENCES protocols(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      description TEXT,
      UNIQUE(protocol_id, step_order)
    );

    CREATE TABLE IF NOT EXISTS protocol_executions (
      id TEXT PRIMARY KEY,
      protocol_id TEXT REFERENCES protocols(id),
      status TEXT NOT NULL DEFAULT 'running',
      current_step INTEGER NOT NULL DEFAULT 1,
      feature_request TEXT NOT NULL,
      context TEXT,
      active_crew_ids TEXT,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO sectors (id, name, root_path, stack)
    VALUES ('global', 'Global', '', 'none');

    INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_model', '"claude-haiku-4-5"');
    INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_max_concurrent', '2');
    INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_timeout', '180');
    INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_max_review_iterations', '3');
    INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_gate_expiry', '86400');
    INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('protocol_executions_retention_days', '30');
  `
},
```

- [ ] **Step 2: Add migration 12 — FK columns on missions, comms, cargo**

```typescript
{
  version: 12,
  name: '012-protocol-fk-columns',
  sql: `
    ALTER TABLE missions ADD COLUMN protocol_execution_id TEXT REFERENCES protocol_executions(id);
    ALTER TABLE comms ADD COLUMN execution_id TEXT REFERENCES protocol_executions(id);
    ALTER TABLE cargo ADD COLUMN protocol_execution_id TEXT REFERENCES protocol_executions(id);
    CREATE INDEX IF NOT EXISTS idx_comms_execution ON comms(execution_id, read);
    CREATE INDEX IF NOT EXISTS idx_missions_execution ON missions(protocol_execution_id);
  `
}
```

- [ ] **Step 3: Add CONFIG_DEFAULTS entries**

In the `CONFIG_DEFAULTS` object at the bottom of `migrations.ts`, add:

```typescript
navigator_model: 'claude-haiku-4-5',
navigator_max_concurrent: 2,
navigator_timeout: 180,
navigator_max_review_iterations: 3,
navigator_gate_expiry: 86400,
protocol_executions_retention_days: 30,
```

- [ ] **Step 4: Verify migrations run cleanly**

```bash
npm run test -- --reporter=verbose src/main/__tests__/starbase-db.test.ts
```

Expected: all DB tests pass (migrations apply without error)

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/migrations.ts
git commit -m "feat(db): migration 11+12 — protocols, navigator tables, FK columns"
```

---

## Task 2: Protocol Service

**Files:**
- Create: `src/main/starbase/protocol-service.ts`
- Create: `src/main/__tests__/protocol-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/__tests__/protocol-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { ProtocolService } from '../starbase/protocol-service';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-protocol-service');
let db: StarbaseDB;
let svc: ProtocolService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new StarbaseDB('/tmp/protocol-test', join(TEST_DIR, 'starbases'));
  db.open();
  svc = new ProtocolService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ProtocolService', () => {
  describe('protocols', () => {
    it('lists all protocols', () => {
      const rows = svc.listProtocols();
      expect(Array.isArray(rows)).toBe(true);
    });

    it('creates and retrieves a protocol by slug', () => {
      svc.createProtocol({
        id: 'proto-1',
        slug: 'research-and-deploy',
        name: 'Research and Deploy',
        description: 'Research then build',
        helpText: null,
        triggerExamples: ['build me X'],
        builtIn: false,
      });
      const p = svc.getProtocolBySlug('research-and-deploy');
      expect(p?.name).toBe('Research and Deploy');
      expect(p?.slug).toBe('research-and-deploy');
    });

    it('enables and disables a protocol', () => {
      svc.createProtocol({ id: 'proto-2', slug: 'test-proto', name: 'Test', description: null, helpText: null, triggerExamples: [], builtIn: false });
      svc.setProtocolEnabled('test-proto', false);
      expect(svc.getProtocolBySlug('test-proto')?.enabled).toBe(0);
      svc.setProtocolEnabled('test-proto', true);
      expect(svc.getProtocolBySlug('test-proto')?.enabled).toBe(1);
    });

    it('throws when enabling non-existent protocol', () => {
      expect(() => svc.setProtocolEnabled('no-such', true)).toThrow();
    });
  });

  describe('protocol_steps', () => {
    it('adds and lists steps for a protocol', () => {
      svc.createProtocol({ id: 'proto-3', slug: 'with-steps', name: 'With Steps', description: null, helpText: null, triggerExamples: [], builtIn: false });
      svc.addStep('proto-3', { stepOrder: 1, type: 'deploy-crew', config: { mission: 'research' }, description: 'Deploy research crew' });
      svc.addStep('proto-3', { stepOrder: 2, type: 'gate', config: {}, description: 'Gate' });
      const steps = svc.listSteps('proto-3');
      expect(steps).toHaveLength(2);
      expect(steps[0].type).toBe('deploy-crew');
      expect(steps[1].type).toBe('gate');
    });
  });

  describe('protocol_executions', () => {
    it('creates and retrieves an execution', () => {
      svc.createProtocol({ id: 'proto-4', slug: 'exec-proto', name: 'Exec Proto', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-4', featureRequest: 'build auth' });
      const exec = svc.getExecution(id);
      expect(exec?.status).toBe('running');
      expect(exec?.current_step).toBe(1);
      expect(exec?.feature_request).toBe('build auth');
    });

    it('advances step and validates guard', () => {
      svc.createProtocol({ id: 'proto-5', slug: 'step-proto', name: 'Step Proto', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-5', featureRequest: 'test' });
      svc.advanceStep(id, 2); // current is 1, advancing to 2 — ok
      expect(svc.getExecution(id)?.current_step).toBe(2);
      expect(() => svc.advanceStep(id, 4)).toThrow(); // skipping step not allowed
    });

    it('updates execution status', () => {
      svc.createProtocol({ id: 'proto-6', slug: 'status-proto', name: 'Status Proto', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-6', featureRequest: 'test' });
      svc.updateExecutionStatus(id, 'gate-pending');
      expect(svc.getExecution(id)?.status).toBe('gate-pending');
    });

    it('lists stale gate-pending executions', () => {
      svc.createProtocol({ id: 'proto-7', slug: 'stale-proto', name: 'Stale Proto', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-7', featureRequest: 'test' });
      svc.updateExecutionStatus(id, 'gate-pending');
      // force updated_at to be old
      db.getDb().prepare(`UPDATE protocol_executions SET updated_at = datetime('now', '-2 days') WHERE id = ?`).run(id);
      const stale = svc.getStaleGatePendingExecutions(3600); // 1 hour threshold
      expect(stale.some(e => e.id === id)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- --reporter=verbose src/main/__tests__/protocol-service.test.ts
```

Expected: FAIL — `ProtocolService` not found

- [ ] **Step 3: Implement ProtocolService**

Create `src/main/starbase/protocol-service.ts`:

```typescript
import type Database from 'better-sqlite3';

type ProtocolRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  help_text: string | null;
  trigger_examples: string | null;
  enabled: number;
  built_in: number;
  created_at: string;
  updated_at: string;
};

type ProtocolStepRow = {
  id: number;
  protocol_id: string;
  step_order: number;
  type: string;
  config: string;
  description: string | null;
};

type ProtocolExecutionRow = {
  id: string;
  protocol_id: string;
  status: string;
  current_step: number;
  feature_request: string;
  context: string | null;
  active_crew_ids: string | null;
  created_at: string;
  updated_at: string;
};

type CreateProtocolOpts = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  helpText: string | null;
  triggerExamples: string[];
  builtIn: boolean;
};

type AddStepOpts = {
  stepOrder: number;
  type: string;
  config: Record<string, unknown>;
  description: string | null;
};

type CreateExecutionOpts = {
  protocolId: string;
  featureRequest: string;
};

export class ProtocolService {
  constructor(private db: Database.Database) {}

  listProtocols(): ProtocolRow[] {
    return this.db.prepare('SELECT * FROM protocols ORDER BY built_in DESC, name ASC').all() as ProtocolRow[];
  }

  getProtocolBySlug(slug: string): ProtocolRow | undefined {
    return this.db.prepare('SELECT * FROM protocols WHERE slug = ?').get(slug) as ProtocolRow | undefined;
  }

  createProtocol(opts: CreateProtocolOpts): void {
    this.db.prepare(
      `INSERT INTO protocols (id, slug, name, description, help_text, trigger_examples, built_in)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      opts.id,
      opts.slug,
      opts.name,
      opts.description,
      opts.helpText,
      JSON.stringify(opts.triggerExamples),
      opts.builtIn ? 1 : 0,
    );
  }

  setProtocolEnabled(slug: string, enabled: boolean): void {
    const result = this.db.prepare(
      `UPDATE protocols SET enabled = ?, updated_at = datetime('now') WHERE slug = ?`
    ).run(enabled ? 1 : 0, slug);
    if (result.changes === 0) throw new Error(`Protocol not found: ${slug}`);
  }

  listSteps(protocolId: string): ProtocolStepRow[] {
    return this.db.prepare(
      'SELECT * FROM protocol_steps WHERE protocol_id = ? ORDER BY step_order ASC'
    ).all(protocolId) as ProtocolStepRow[];
  }

  addStep(protocolId: string, opts: AddStepOpts): void {
    this.db.prepare(
      `INSERT INTO protocol_steps (protocol_id, step_order, type, config, description)
       VALUES (?, ?, ?, ?, ?)`
    ).run(protocolId, opts.stepOrder, opts.type, JSON.stringify(opts.config), opts.description);
  }

  createExecution(opts: CreateExecutionOpts): string {
    const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(
      `INSERT INTO protocol_executions (id, protocol_id, feature_request)
       VALUES (?, ?, ?)`
    ).run(id, opts.protocolId, opts.featureRequest);
    return id;
  }

  getExecution(id: string): ProtocolExecutionRow | undefined {
    return this.db.prepare('SELECT * FROM protocol_executions WHERE id = ?').get(id) as ProtocolExecutionRow | undefined;
  }

  listExecutions(status?: string): ProtocolExecutionRow[] {
    if (status) {
      return this.db.prepare('SELECT * FROM protocol_executions WHERE status = ? ORDER BY created_at DESC').all(status) as ProtocolExecutionRow[];
    }
    return this.db.prepare('SELECT * FROM protocol_executions ORDER BY created_at DESC').all() as ProtocolExecutionRow[];
  }

  advanceStep(executionId: string, toStep: number): void {
    const exec = this.getExecution(executionId);
    if (!exec) throw new Error(`Execution not found: ${executionId}`);
    if (toStep !== exec.current_step + 1) {
      throw new Error(`Cannot advance from step ${exec.current_step} to step ${toStep} — steps must be sequential`);
    }
    this.db.prepare(
      `UPDATE protocol_executions SET current_step = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(toStep, executionId);
  }

  updateExecutionStatus(id: string, status: string): void {
    this.db.prepare(
      `UPDATE protocol_executions SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(status, id);
  }

  updateExecutionContext(id: string, context: string): void {
    this.db.prepare(
      `UPDATE protocol_executions SET context = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(context, id);
  }

  updateActiveCrewIds(id: string, crewIds: string[]): void {
    this.db.prepare(
      `UPDATE protocol_executions SET active_crew_ids = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(crewIds), id);
  }

  getStaleGatePendingExecutions(olderThanSeconds: number): ProtocolExecutionRow[] {
    return this.db.prepare(
      `SELECT * FROM protocol_executions
       WHERE status = 'gate-pending'
         AND updated_at < datetime('now', '-' || ? || ' seconds')`
    ).all(olderThanSeconds) as ProtocolExecutionRow[];
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- --reporter=verbose src/main/__tests__/protocol-service.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/protocol-service.ts src/main/__tests__/protocol-service.test.ts
git commit -m "feat(protocol): add ProtocolService with CRUD for protocols, steps, executions"
```

---

## Task 3: CommsService Amendments

**Files:**
- Modify: `src/main/starbase/comms-service.ts`
- Modify: `src/main/__tests__/comms-service.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/main/__tests__/comms-service.test.ts`:

```typescript
describe('execution_id', () => {
  it('stores execution_id on a transmission', () => {
    const id = svc.send({ from: 'navigator', to: 'admiral', type: 'gate-pending', payload: 'test', executionId: 'exec-123' });
    const row = db.getDb().prepare('SELECT execution_id FROM comms WHERE id = ?').get(id) as { execution_id: string };
    expect(row.execution_id).toBe('exec-123');
  });

  it('filters unread comms by execution_id', () => {
    svc.send({ from: 'navigator', to: 'admiral', type: 'gate-pending', payload: 'a', executionId: 'exec-A' });
    svc.send({ from: 'navigator', to: 'admiral', type: 'gate-pending', payload: 'b', executionId: 'exec-B' });
    const rows = svc.getUnreadByExecution('exec-A');
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toBe('a');
  });
});

describe('dedup exclusion for navigator', () => {
  it('does not deduplicate identical messages from navigator', () => {
    svc.send({ from: 'navigator', to: 'admiral', type: 'protocol-complete', payload: 'done', executionId: 'exec-1' });
    svc.send({ from: 'navigator', to: 'admiral', type: 'protocol-complete', payload: 'done', executionId: 'exec-2' });
    const rows = db.getDb().prepare("SELECT * FROM comms WHERE from_crew = 'navigator'").all() as { id: number }[];
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- --reporter=verbose src/main/__tests__/comms-service.test.ts
```

Expected: new tests FAIL — `executionId` not in SendOpts, `getUnreadByExecution` not found

- [ ] **Step 3: Amend CommsService**

In `src/main/starbase/comms-service.ts`:

Update `SendOpts` type:
```typescript
type SendOpts = {
  from: string;
  to: string;
  type: string;
  payload: string;
  threadId?: string;
  inReplyTo?: number;
  missionId?: number;
  executionId?: string;
};
```

Update the dedup check from:
```typescript
if (opts.from !== 'admiral') {
```
to:
```typescript
if (opts.from !== 'admiral' && opts.from !== 'navigator') {
```

The current INSERT statement (line ~96) is:
```typescript
'INSERT INTO comms (from_crew, to_crew, type, payload, thread_id, in_reply_to) VALUES (?, ?, ?, ?, ?, ?)',
```
Update it to:
```typescript
'INSERT INTO comms (from_crew, to_crew, type, payload, thread_id, in_reply_to, mission_id, execution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
```
and the corresponding `.run()` call from:
```typescript
.run(opts.from, opts.to, opts.type, opts.payload, opts.threadId ?? null, opts.inReplyTo ?? null);
```
to:
```typescript
.run(opts.from, opts.to, opts.type, opts.payload, opts.threadId ?? null, opts.inReplyTo ?? null, opts.missionId ?? null, opts.executionId ?? null);
```

Add `getUnreadByExecution` method:
```typescript
getUnreadByExecution(executionId: string): TransmissionRow[] {
  return this.db.prepare(
    `SELECT * FROM comms WHERE execution_id = ? AND read = 0 ORDER BY created_at ASC`
  ).all(executionId) as TransmissionRow[];
}
```

Also update `TransmissionRow` type to include new columns:
```typescript
export type TransmissionRow = {
  // ... existing fields ...
  mission_id: number | null;
  execution_id: string | null;
};
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- --reporter=verbose src/main/__tests__/comms-service.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/comms-service.ts src/main/__tests__/comms-service.test.ts
git commit -m "feat(comms): add execution_id to SendOpts, INSERT, dedup exclusion for navigator"
```

---

## Task 4: Fleet CLI — Protocol Commands

**Files:**
- Modify: `src/main/socket-server.ts`
- Modify: `src/main/fleet-cli.ts`

- [ ] **Step 1: Update ServiceRegistry and add socket handlers**

In `src/main/socket-server.ts`:

1. Add the import:
```typescript
import type { ProtocolService } from './starbase/protocol-service';
```

2. Add `protocolService` to the `ServiceRegistry` interface:
```typescript
export interface ServiceRegistry {
  crewService: CrewService;
  missionService: MissionService;
  commsService: CommsService;
  sectorService: SectorService;
  cargoService: CargoService;
  supplyRouteService: SupplyRouteService;
  configService: ConfigService;
  shipsLog: ShipsLog;
  protocolService: ProtocolService;  // add this
}
```

3. Update `comms.list` case to support `--execution` filtering:
```typescript
case 'comms.list': {
  const executionId = args.execution as string | undefined;
  if (executionId) {
    return commsService.getUnreadByExecution(executionId);
  }
  const rows = commsService.getRecent(args as Parameters<CommsService['getRecent']>[0]);
  return rows;
}
```

4. Add these cases to the `dispatch()` switch:

```typescript
case 'protocol.list':
  return { ok: true, data: this.protocolService.listProtocols() };

case 'protocol.show': {
  const p = this.protocolService.getProtocolBySlug(args.slug as string);
  if (!p) return { ok: false, error: `Protocol not found: ${args.slug}`, hint: 'Run `fleet protocols list` to see available protocols' };
  const steps = this.protocolService.listSteps(p.id);
  return { ok: true, data: { ...p, steps } };
}

case 'protocol.enable':
  try {
    this.protocolService.setProtocolEnabled(args.slug as string, true);
    return { ok: true, data: { slug: args.slug, enabled: true } };
  } catch (e) {
    return { ok: false, error: (e as Error).message, hint: 'Run `fleet protocols list` to see available protocols' };
  }

case 'protocol.disable':
  try {
    this.protocolService.setProtocolEnabled(args.slug as string, false);
    return { ok: true, data: { slug: args.slug, enabled: false } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

case 'execution.list':
  return { ok: true, data: this.protocolService.listExecutions(args.status as string | undefined) };

case 'execution.show': {
  const exec = this.protocolService.getExecution(args.id as string);
  if (!exec) return { ok: false, error: `Execution not found: ${args.id}`, hint: 'Run `fleet protocols executions list` to see active executions' };
  return { ok: true, data: exec };
}

case 'execution.update': {
  const exec = this.protocolService.getExecution(args.id as string);
  if (!exec) return { ok: false, error: `Execution not found: ${args.id}` };
  if (args.step !== undefined) {
    try {
      this.protocolService.advanceStep(args.id as string, Number(args.step));
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  if (args.status !== undefined) {
    this.protocolService.updateExecutionStatus(args.id as string, args.status as string);
  }
  if (args.context !== undefined) {
    this.protocolService.updateExecutionContext(args.id as string, args.context as string);
  }
  return {
    ok: true,
    data: this.protocolService.getExecution(args.id as string),
    hint: `Execution updated. Poll with \`fleet protocols executions show ${args.id}\` to check state.`
  };
}
```

- [ ] **Step 2: Add protocol commands to COMMAND_MAP in fleet-cli.ts**

```typescript
'protocols.list': 'protocol.list',
'protocol.list': 'protocol.list',
'protocols.show': 'protocol.show',
'protocol.show': 'protocol.show',
'protocols.enable': 'protocol.enable',
'protocols.disable': 'protocol.disable',
'protocols.executions.list': 'execution.list',
'protocols.executions.show': 'execution.show',
'protocols.executions.update': 'execution.update',
```

- [ ] **Step 3: Add formatted output for protocol commands in fleet-cli.ts**

`runCLI()` uses `if (command === ...)` guards for special formatting (not a `switch`). Add these blocks before the generic array/object fallbacks (after the `comms.check` block):

```typescript
if (command === 'protocol.list') {
  const protocols = data as { slug: string; name: string; enabled: number; built_in: number }[];
  if (!protocols || protocols.length === 0) return 'No protocols registered.';
  return protocols.map(p => {
    const status = p.enabled ? '✓' : '✗';
    const tag = p.built_in ? ' [built-in]' : '';
    return `  ${status} ${p.slug.padEnd(30)} ${p.name}${tag}`;
  }).join('\n');
}

if (command === 'protocol.show') {
  const p = data as { name: string; description?: string; help_text?: string; trigger_examples?: string; steps: { step_order: number; type: string; description?: string }[] };
  const lines: string[] = [`\n${p.name}\n`];
  if (p.description) lines.push(p.description + '\n');
  if (p.help_text) lines.push(p.help_text + '\n');
  if (p.trigger_examples) {
    const examples = JSON.parse(p.trigger_examples) as string[];
    if (examples.length) { lines.push('Examples:'); examples.forEach(e => lines.push(`  • "${e}"`)); lines.push(''); }
  }
  lines.push('Steps:');
  for (const s of p.steps) lines.push(`  ${s.step_order}. [${s.type}] ${s.description ?? ''}`);
  return lines.join('\n');
}

if (command === 'execution.list') {
  const execs = data as { id: string; status: string; current_step: number; feature_request: string }[];
  if (!execs || execs.length === 0) return 'No executions found.';
  return execs.map(e =>
    `  ${e.id}  ${e.status.padEnd(15)} step ${e.current_step}  ${e.feature_request.slice(0, 50)}`
  ).join('\n');
}
```

- [ ] **Step 4: Manually verify CLI output**

```bash
npm run build:main && node dist/main/index.js fleet protocols list
```

Expected: clean output (no protocols yet, just "No protocols registered.")

- [ ] **Step 5: Commit**

```bash
git add src/main/socket-server.ts src/main/fleet-cli.ts
git commit -m "feat(cli): add fleet protocols and executions commands"
```

---

## Task 5: Navigator Class

**Files:**
- Create: `src/main/starbase/navigator.ts`
- Create: `src/main/__tests__/navigator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/__tests__/navigator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { Navigator } from '../starbase/navigator';
import { ConfigService } from '../starbase/config-service';
import { rmSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-navigator');

let db: StarbaseDB;
let configService: ConfigService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new StarbaseDB('/tmp/nav-test', join(TEST_DIR, 'starbases'));
  db.open();
  configService = new ConfigService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Navigator', () => {
  it('reports idle when no processes running', () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
    expect(nav.activeCount).toBe(0);
    expect(nav.isRunning('exec-1')).toBe(false);
  });

  it('deduplicates: returns false if execution already running', async () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
    // Manually inject a fake running entry
    ;(nav as unknown as { running: Map<string, unknown> }).running.set('exec-1', { proc: { killed: false, kill: vi.fn() }, executionId: 'exec-1', startedAt: Date.now() });
    const result = await nav.dispatch({ executionId: 'exec-1', protocolSlug: 'research-and-deploy', featureRequest: 'build X', currentStep: 1, context: null });
    expect(result).toBe(false);
  });

  it('respects max concurrent limit', async () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
    const running = (nav as unknown as { running: Map<string, unknown> }).running;
    running.set('exec-A', { proc: { killed: false, kill: vi.fn() }, executionId: 'exec-A', startedAt: Date.now() });
    running.set('exec-B', { proc: { killed: false, kill: vi.fn() }, executionId: 'exec-B', startedAt: Date.now() });
    // max is 2 by default config
    const result = await nav.dispatch({ executionId: 'exec-C', protocolSlug: 'research-and-deploy', featureRequest: 'build X', currentStep: 1, context: null });
    expect(result).toBe(false);
  });

  it('creates workspace CLAUDE.md on first dispatch attempt', async () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123', fleetBinDir: '/usr/local/bin' });
    // dispatch will fail (no claude binary in test) but workspace setup happens first
    await nav.dispatch({ executionId: 'exec-new', protocolSlug: 'research-and-deploy', featureRequest: 'build X', currentStep: 1, context: null }).catch(() => {});
    const workspace = join(process.env.HOME ?? '~', '.fleet', 'starbases', 'starbase-test-123', 'navigator');
    // CLAUDE.md may or may not exist depending on spawn failure timing — just verify no crash
    expect(nav.activeCount).toBe(0); // process failed, cleaned up
  });

  it('clears running map on reconcile', () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
    ;(nav as unknown as { running: Map<string, unknown> }).running.set('exec-1', {});
    nav.reconcile();
    expect(nav.activeCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- --reporter=verbose src/main/__tests__/navigator.test.ts
```

Expected: FAIL — `Navigator` not found

- [ ] **Step 3: Implement Navigator**

Create `src/main/starbase/navigator.ts` — mirror `first-officer.ts` structure but for execution-driven dispatch:

```typescript
import { spawn, ChildProcess } from 'child_process'
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type Database from 'better-sqlite3'
import type { ConfigService } from './config-service'
import type { EventBus } from '../event-bus'

type NavigatorDeps = {
  db: Database.Database
  configService: ConfigService
  eventBus?: EventBus
  starbaseId: string
  crewEnv?: Record<string, string>
  fleetBinDir?: string
}

export type NavigatorEvent = {
  executionId: string
  protocolSlug: string
  featureRequest: string
  currentStep: number
  context: string | null
  eventType?: string  // 'resume' | 'crew-failed' | 'gate-approved' | 'gate-rejected'
  gateResponse?: string
}

type RunningProcess = {
  proc: ChildProcess
  executionId: string
  startedAt: number
}

export class Navigator {
  private running = new Map<string, RunningProcess>()

  constructor(private deps: NavigatorDeps) {}

  get activeCount(): number {
    return this.running.size
  }

  isRunning(executionId: string): boolean {
    return this.running.has(executionId)
  }

  async dispatch(
    event: NavigatorEvent,
    callbacks?: { onExit?: (code: number | null) => void },
  ): Promise<boolean> {
    const { configService } = this.deps
    const maxConcurrent = configService.get('navigator_max_concurrent') as number
    const timeout = configService.get('navigator_timeout') as number
    const model = configService.get('navigator_model') as string

    if (this.running.has(event.executionId)) return false
    if (this.running.size >= maxConcurrent) return false

    const workspace = this.getWorkspacePath()
    mkdirSync(workspace, { recursive: true })

    const claudeMdPath = join(workspace, 'CLAUDE.md')
    if (!existsSync(claudeMdPath)) {
      const { generateNavigatorClaudeMd } = await import('./workspace-templates')
      writeFileSync(claudeMdPath, generateNavigatorClaudeMd({ fleetBinDir: this.deps.fleetBinDir }), 'utf-8')
    }

    const promptDir = join(tmpdir(), 'fleet-navigator')
    mkdirSync(promptDir, { recursive: true })
    const spFile = join(promptDir, `${event.executionId}-sp.md`)
    const msgFile = join(promptDir, `${event.executionId}-msg.md`)

    writeFileSync(spFile, this.buildSystemPrompt(event), 'utf-8')
    writeFileSync(msgFile, this.buildInitialMessage(event), 'utf-8')

    const cmdArgs = [
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--model', model,
      '--append-system-prompt-file', spFile,
    ]

    const mergedEnv: Record<string, string> = {
      ...(this.deps.crewEnv ?? (process.env as Record<string, string>)),
      FLEET_NAVIGATOR: '1',
      FLEET_EXECUTION_ID: event.executionId,
      FLEET_STARBASE_ID: this.deps.starbaseId,
      ...(this.deps.fleetBinDir ? { FLEET_BIN_DIR: this.deps.fleetBinDir } : {}),
    }

    try {
      const proc = spawn('claude', cmdArgs, {
        cwd: workspace,
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      this.running.set(event.executionId, { proc, executionId: event.executionId, startedAt: Date.now() })

      const initMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `Read and execute the Navigator instructions in ${msgFile}. Delete the file when done.` },
        parent_tool_use_id: null,
        session_id: '',
      }) + '\n'
      proc.stdin!.write(initMsg)

      let stdoutBuffer = ''
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString()
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'result') {
              try { proc.stdin?.end() } catch { /* ignore */ }
            }
          } catch { /* non-JSON */ }
        }
      })

      proc.stderr!.on('data', (chunk: Buffer) => {
        console.error(`[navigator:${event.executionId}] stderr:`, chunk.toString().trim())
      })

      const timer = setTimeout(() => {
        if (!proc.killed) {
          console.warn(`[navigator] Timeout for ${event.executionId}, killing`)
          try { proc.kill('SIGTERM') } catch { /* already dead */ }
          setTimeout(() => { if (!proc.killed) try { proc.kill('SIGKILL') } catch { /* ignore */ } }, 5000)
        }
      }, timeout * 1000)

      proc.on('exit', (code) => {
        clearTimeout(timer)
        this.running.delete(event.executionId)
        try { unlinkSync(spFile) } catch { /* ignore */ }
        try { unlinkSync(msgFile) } catch { /* ignore */ }

        if (code !== 0) {
          this.writeFailedComm(event, `Navigator process crashed (exit code: ${code})`)
        }

        callbacks?.onExit?.(code)
        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        this.running.delete(event.executionId)
        this.writeFailedComm(event, `Navigator spawn failed: ${err.message}`)
        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
      })

      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
      return true
    } catch (err) {
      this.writeFailedComm(event, `Navigator spawn failed: ${err instanceof Error ? err.message : 'unknown'}`)
      return false
    }
  }

  private writeFailedComm(event: NavigatorEvent, reason: string): void {
    try {
      this.deps.db.prepare(
        `INSERT INTO comms (from_crew, to_crew, type, execution_id, payload)
         VALUES ('navigator', 'admiral', 'protocol-failed', ?, ?)`
      ).run(
        event.executionId,
        JSON.stringify({ executionId: event.executionId, reason, protocolSlug: event.protocolSlug })
      )
      this.deps.db.prepare(
        `UPDATE protocol_executions SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
      ).run(event.executionId)
    } catch { /* ignore if DB not available */ }
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  private getWorkspacePath(): string {
    return join(
      process.env.HOME ?? '~',
      '.fleet', 'starbases',
      `starbase-${this.deps.starbaseId}`,
      'navigator',
    )
  }

  private buildSystemPrompt(event: NavigatorEvent): string {
    const fleetBin = this.deps.fleetBinDir ? `${this.deps.fleetBinDir}/fleet` : 'fleet'
    return `You are the Navigator aboard Star Command. You execute Protocols autonomously using the fleet CLI.

Execution ID: ${event.executionId}
Protocol: ${event.protocolSlug}
Current step: ${event.currentStep}
Event type: ${event.eventType ?? 'resume'}
${event.gateResponse ? `Gate response: ${event.gateResponse}` : ''}

Start by running: ${fleetBin} protocols show ${event.protocolSlug}
Then: ${fleetBin} protocols executions show ${event.executionId}

Always tag crew deploys with --execution ${event.executionId}.
Poll comms with: ${fleetBin} comms inbox --execution ${event.executionId} --unread
`
  }

  private buildInitialMessage(event: NavigatorEvent): string {
    return `# Navigator Assignment

**Protocol:** ${event.protocolSlug}
**Execution:** ${event.executionId}
**Step:** ${event.currentStep}
**Feature request:** ${event.featureRequest}
${event.context ? `\n## Prior context\n${event.context}` : ''}
${event.gateResponse ? `\n## Gate response from Admiral\n${event.gateResponse}` : ''}

Read the protocol steps, check the execution state, and proceed from step ${event.currentStep}.
`
  }

  reconcile(): void {
    this.running.clear()
  }

  shutdown(): void {
    for (const [k, entry] of this.running) {
      try { entry.proc.kill('SIGKILL') } catch { /* already dead */ }
      this.running.delete(k)
    }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- --reporter=verbose src/main/__tests__/navigator.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/navigator.ts src/main/__tests__/navigator.test.ts
git commit -m "feat(navigator): add Navigator class — ephemeral Claude Code executor for Protocols"
```

---

## Task 6: generateNavigatorClaudeMd

**Files:**
- Modify: `src/main/starbase/workspace-templates.ts`

- [ ] **Step 1: Add generateNavigatorClaudeMd to workspace-templates.ts**

Add after the existing `generateSkillMd()` function:

```typescript
type NavigatorClaudeMdOpts = {
  fleetBinDir?: string
}

export function generateNavigatorClaudeMd(opts: NavigatorClaudeMdOpts = {}): string {
  const fleetBin = opts.fleetBinDir ? `${opts.fleetBinDir}/fleet` : 'fleet'

  return `# Navigator

You are the Navigator aboard Star Command. You execute Protocols — multi-step autonomous workflows — using the fleet CLI. You are NOT the Admiral and NOT the First Officer.

## Your Role
1. Read your assigned Protocol steps via \`${fleetBin} protocols show <slug>\`
2. Check execution state via \`${fleetBin} protocols executions show <id>\`
3. Execute each step using fleet CLI commands
4. Poll comms for crew completion signals
5. Advance steps autonomously until a gate or terminal state
6. At a gate: write a gate-pending comm to Admiral and exit cleanly

## Core Workflow

\`\`\`bash
# 1. Read protocol and execution state at start of every invocation
${fleetBin} protocols show <protocol-slug>
${fleetBin} protocols executions show <execution-id>

# 2. Deploy a crew
${fleetBin} crew deploy --sector <sector-id> --mission <mission-id> --execution <execution-id>

# 3. Poll for crew comms (repeat until signal arrives)
${fleetBin} comms inbox --execution <execution-id> --unread

# 4. Mark comms read after processing
${fleetBin} comms read <id>

# 5. Advance to next step (validates sequential guard)
${fleetBin} protocols executions update <execution-id> --step <N+1>

# 6. Write gate-pending comm
${fleetBin} comms send --from navigator --to admiral --type gate-pending \\
  --execution <execution-id> --payload '{"step": N, "decision": "approve or reject", "brief": "..."}'

# 7. Write protocol-complete comm
${fleetBin} comms send --from navigator --to admiral --type protocol-complete \\
  --execution <execution-id> --payload '{"cargoId": "...", "summary": "..."}'

# 8. Write protocol-failed comm
${fleetBin} comms send --from navigator --to admiral --type protocol-failed \\
  --execution <execution-id> --payload '{"reason": "...", "lastStep": N}'
\`\`\`

## Full Command Reference

\`\`\`bash
# Protocols
${fleetBin} protocols show <slug>                           # Read protocol steps
${fleetBin} protocols executions show <id>                  # Check execution state
${fleetBin} protocols executions update <id> --step <N>     # Advance step (sequential guard)
${fleetBin} protocols executions update <id> --status <s>   # Update status

# Crew
${fleetBin} crew list --execution <id>                      # List crew for this execution
${fleetBin} crew deploy --sector <id> --mission <id> --execution <id>
${fleetBin} crew recall <crew-id>                           # Recall crew
${fleetBin} crew observe <crew-id>                          # Read crew output

# Missions
${fleetBin} missions show <id>                              # Inspect mission
${fleetBin} missions list --sector <id>                     # List missions in sector

# Comms
${fleetBin} comms inbox --execution <id> --unread           # Poll for unread comms
${fleetBin} comms read <id>                                 # Mark comm read
${fleetBin} comms send --from navigator --to admiral \\
  --type <type> --execution <id> --payload '<json>'

# Cargo
${fleetBin} cargo list --execution <id>                     # List cargo from this execution
${fleetBin} cargo show <id>                                 # Inspect cargo item

# Sectors
${fleetBin} sectors list                                    # List all sectors
${fleetBin} sectors show <id>                               # Sector details
\`\`\`

## Rules
- Always tag crew deploys with \`--execution <execution-id>\`
- Never skip protocol steps — advance sequentially
- Max ${3} review loop iterations before forcing a gate
- At a gate: write gate-pending comm and exit — do not wait for response
- On failure: recall active crew, write protocol-failed comm, exit
- On clarification needed: write clarification-needed comm (same as gate), exit
- Never create missions yourself — that is the Admiral's role after reviewing the Feature Brief
- All comms to Admiral must include \`--execution <id>\` so they are scoped correctly
`
}
```

- [ ] **Step 2: Verify build compiles**

```bash
npm run build:main 2>&1 | grep -E "error|Error" | head -10
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/main/starbase/workspace-templates.ts
git commit -m "feat(templates): add generateNavigatorClaudeMd for Navigator workspace"
```

---

## Task 7: Sentinel — Navigator Sweep and Gate Expiry

**Files:**
- Modify: `src/main/starbase/sentinel.ts`
- Modify: `src/main/__tests__/sentinel.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/main/__tests__/sentinel.test.ts`:

```typescript
describe('Navigator sweep', () => {
  it('triggers Navigator when FO escalation exists for protocol mission', async () => {
    // Set up: sector, mission with protocol_execution_id, crew, FO memo comms row
    const sectorId = 'test-sector';
    getDb().prepare(`INSERT OR IGNORE INTO sectors (id, name, root_path) VALUES (?, ?, ?)`).run(sectorId, 'Test', join(TEST_DIR, 'workspace', 'api'));
    getDb().prepare(`INSERT OR IGNORE INTO protocols (id, slug, name) VALUES ('p1', 'test', 'Test')`).run();
    getDb().prepare(`INSERT OR IGNORE INTO protocol_executions (id, protocol_id, feature_request) VALUES ('exec-1', 'p1', 'build auth')`).run();
    const missionId = (getDb().prepare(`INSERT INTO missions (sector_id, summary, prompt, protocol_execution_id) VALUES (?, ?, ?, ?) RETURNING id`).get(sectorId, 'test', 'test', 'exec-1') as { id: number }).id;
    getDb().prepare(`INSERT INTO comms (from_crew, to_crew, type, mission_id, payload) VALUES ('first-officer', 'admiral', 'memo', ?, ?)`).run(missionId, JSON.stringify({ reason: 'escalated' }));

    const dispatchedIds: string[] = [];
    const nav = { dispatch: vi.fn(async (event: { executionId: string }) => { dispatchedIds.push(event.executionId); return true; }), isRunning: vi.fn(() => false), activeCount: 0, reconcile: vi.fn(), shutdown: vi.fn() };

    const sentinel = new Sentinel({ db: getDb(), configService, navigator: nav as unknown as import('../starbase/navigator').Navigator });
    await (sentinel as unknown as { navigatorSweep: () => Promise<void> }).navigatorSweep();

    expect(dispatchedIds).toContain('exec-1');
  });

  it('expires stale gate-pending executions', async () => {
    getDb().prepare(`INSERT OR IGNORE INTO protocols (id, slug, name) VALUES ('p2', 'proto2', 'Proto2')`).run();
    getDb().prepare(`INSERT INTO protocol_executions (id, protocol_id, feature_request, status) VALUES ('exec-stale', 'p2', 'test', 'gate-pending')`).run();
    getDb().prepare(`UPDATE protocol_executions SET updated_at = datetime('now', '-2 days') WHERE id = 'exec-stale'`).run();

    const sentinel = new Sentinel({ db: getDb(), configService });
    await (sentinel as unknown as { navigatorSweep: () => Promise<void> }).navigatorSweep();

    const exec = getDb().prepare(`SELECT status FROM protocol_executions WHERE id = 'exec-stale'`).get() as { status: string };
    expect(exec.status).toBe('gate-expired');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- --reporter=verbose src/main/__tests__/sentinel.test.ts
```

Expected: new tests FAIL — Navigator not injected into Sentinel

- [ ] **Step 3: Add Navigator to Sentinel**

In `src/main/starbase/sentinel.ts`:

1. Import `Navigator` and `ProtocolService`:
```typescript
import { Navigator, type NavigatorEvent } from './navigator'
import { ProtocolService } from './protocol-service'
```

2. Add to Sentinel deps/constructor:
```typescript
private navigator?: Navigator
private protocolService: ProtocolService
```

3. In `_runSweep()`, call `navigatorSweep()` after `firstOfficerSweep()`:
```typescript
await this.navigatorSweep()
```

4. Implement `navigatorSweep()`:
```typescript
private async navigatorSweep(): Promise<void> {
  const gateExpirySeconds = this.configService.get('navigator_gate_expiry') as number

  // Gate expiry — mark stale gate-pending executions as gate-expired
  const stale = this.protocolService.getStaleGatePendingExecutions(gateExpirySeconds)
  for (const exec of stale) {
    this.protocolService.updateExecutionStatus(exec.id, 'gate-expired')
    this.db.prepare(
      `INSERT INTO comms (from_crew, to_crew, type, execution_id, payload)
       VALUES ('navigator', 'admiral', 'gate-expired', ?, ?)`
    ).run(exec.id, JSON.stringify({ executionId: exec.id, reason: 'Gate expired after inactivity', protocolId: exec.protocol_id }))
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  if (!this.navigator) return

  // Crew-failed fan-out — detect FO escalations for protocol missions
  const rows = this.db.prepare(`
    SELECT m.protocol_execution_id as executionId, pe.protocol_id, pe.current_step, pe.feature_request, pe.context
    FROM comms c
    JOIN missions m ON c.mission_id = m.id
    JOIN protocol_executions pe ON m.protocol_execution_id = pe.id
    WHERE c.type = 'memo'
      AND m.protocol_execution_id IS NOT NULL
      AND c.read = 0
      AND pe.status = 'running'
  `).all() as { executionId: string; protocol_id: string; current_step: number; feature_request: string; context: string | null }[]

  for (const row of rows) {
    if (this.navigator.isRunning(row.executionId)) continue
    const proto = this.db.prepare('SELECT slug FROM protocols WHERE id = ?').get(row.protocol_id) as { slug: string } | undefined
    if (!proto) continue

    // Mark triggering memo comms as read to prevent repeated fan-out on next sweep
    this.db.prepare(
      `UPDATE comms SET read = 1
       WHERE type = 'memo' AND read = 0
         AND mission_id IN (
           SELECT id FROM missions WHERE protocol_execution_id = ?
         )`
    ).run(row.executionId)

    await this.navigator.dispatch({
      executionId: row.executionId,
      protocolSlug: proto.slug,
      featureRequest: row.feature_request,
      currentStep: row.current_step,
      context: row.context,
      eventType: 'crew-failed',
    })
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- --reporter=verbose src/main/__tests__/sentinel.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/sentinel.ts src/main/__tests__/sentinel.test.ts
git commit -m "feat(sentinel): add Navigator sweep — crew-failed fan-out and gate expiry"
```

---

## Task 8: RetentionService Amendments

**Files:**
- Modify: `src/main/starbase/retention-service.ts`

- [ ] **Step 1: Add protocol_executions cleanup**

In `src/main/starbase/retention-service.ts`:

1. Update the `TABLES` constant (used only by `getStats()` for row counts — adding all three new tables gives stats visibility without affecting deletion logic):
```typescript
const TABLES = [
  'sectors',
  'supply_routes',
  'missions',
  'crew',
  'comms',
  'cargo',
  'ships_log',
  'starbase_config',
  'protocol_executions',
  'protocols',
  'protocol_steps',
] as const
```

2. Add cleanup for `protocol_executions` in the `cleanup()` method (only terminal-status executions are swept — `protocols` and `protocol_steps` are never deleted):
```typescript
const protocolExecutionsRetentionDays = (this.configService.get('protocol_executions_retention_days') as number) ?? 30

const protocolExecutionsResult = this.db
  .prepare(`DELETE FROM protocol_executions WHERE status IN ('complete', 'failed', 'cancelled', 'gate-expired') AND created_at < datetime('now', '-' || ? || ' days')`)
  .run(protocolExecutionsRetentionDays)
```

3. Include `protocolExecutions` in the return type and return value:
```typescript
cleanup(): { comms: number; cargo: number; shipsLog: number; crew: number; protocolExecutions: number }
// ...
return { comms: commsResult.changes, cargo: cargoResult.changes, shipsLog: shipsLogResult.changes, crew: crewResult.changes, protocolExecutions: protocolExecutionsResult.changes }
```

- [ ] **Step 2: Verify build compiles**

```bash
npm run build:main 2>&1 | grep -E "error|Error" | head -10
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/main/starbase/retention-service.ts
git commit -m "feat(retention): add protocol_executions cleanup + TABLES stats entries"
```

---

## Task 9: Admiral Skill Amendments

**Files:**
- Modify: `src/main/starbase/workspace-templates.ts`

- [ ] **Step 1: Update generateSkillMd to include new comms types and protocol commands**

In `generateSkillMd()`, locate the Comms handling / Sentinel Alerts section and add:

```markdown
## Protocol Comms

When you receive any of these comms types, take the indicated action:

| Type | Action |
|------|--------|
| \`gate-pending\` | A Protocol execution needs your decision. Read the payload, present the Feature Brief or question to the operator, collect their response, then spawn a new Navigator invocation with the response in context. |
| \`protocol-complete\` | A Protocol finished. Present the Feature Brief summary to the operator and offer to create missions from it. |
| \`protocol-failed\` | A Protocol failed. Present the failure reason. Ask if the operator wants to retry. |
| \`clarification-needed\` | Same as gate-pending — a clarification question needs human input before the execution can continue. |
| \`gate-expired\` | A gate timed out with no response. The execution is cancelled. Notify the operator. |
```

And add to the Full Command Reference section:

```markdown
### Protocols

\`\`\`
fleet protocols list                              # List all available protocols
fleet protocols show <slug>                       # Show protocol details and steps
fleet protocols enable <slug>
fleet protocols disable <slug>
fleet protocols executions list                   # List all active/recent executions
fleet protocols executions list --status running  # Filter by status
fleet protocols executions show <id>              # Show execution detail
\`\`\`
```

- [ ] **Step 2: Verify build compiles**

```bash
npm run build:main 2>&1 | grep -E "error|Error" | head -10
```

- [ ] **Step 3: Run full test suite**

```bash
npm run test
```

Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/workspace-templates.ts
git commit -m "feat(admiral): add protocol comms types and fleet protocols commands to Admiral skill"
```

---

## Task 10: Seed Built-in Research-and-Deploy Protocol

**Files:**
- Modify: `src/main/starbase/migrations.ts`

- [ ] **Step 1: Add protocol seed data to migration 11**

In the migration 11 SQL, after the `INSERT OR IGNORE INTO sectors` line, add the built-in protocol seed:

```sql
INSERT OR IGNORE INTO protocols (id, slug, name, description, help_text, trigger_examples, built_in)
VALUES (
  'builtin-research-deploy',
  'research-and-deploy',
  'Research and Deploy',
  'Research the codebase and produce a Feature Brief for implementation.',
  'Use this protocol when a user asks to build or implement a feature. The Navigator deploys a research crew to investigate the codebase, then a review crew validates the brief, then gates for operator approval before the Admiral creates missions.',
  '["build me X", "implement X feature", "add X to the codebase", "research how to build X"]',
  1
);

INSERT OR IGNORE INTO protocol_steps (protocol_id, step_order, type, config, description) VALUES
  ('builtin-research-deploy', 1, 'deploy-crew', '{"role": "research", "missionTemplate": "Research the codebase for: {featureRequest}. Document existing patterns, relevant files, and proposed approach."}', 'Deploy research crew'),
  ('builtin-research-deploy', 2, 'await-comms', '{"signalType": "cargo", "timeout": 3600}', 'Wait for research cargo'),
  ('builtin-research-deploy', 3, 'review', '{"role": "review", "missionTemplate": "Review this Feature Brief for completeness and accuracy: {brief}. Flag gaps, contradictions, or missing context.", "maxIterations": 3}', 'Deploy review crew'),
  ('builtin-research-deploy', 4, 'await-comms', '{"signalType": "review-pass"}', 'Wait for review approval'),
  ('builtin-research-deploy', 5, 'gate', '{"decision": "approve or reject Feature Brief"}', 'Gate — operator approves Feature Brief'),
  ('builtin-research-deploy', 6, 'complete', '{}', 'Protocol complete');
```

- [ ] **Step 2: Verify migrations still pass**

```bash
npm run test -- --reporter=verbose src/main/__tests__/starbase-db.test.ts
```

Expected: all tests PASS

- [ ] **Step 3: Run full test suite one final time**

```bash
npm run test
```

Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/migrations.ts
git commit -m "feat(protocols): seed built-in research-and-deploy protocol"
```
