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
      opts.id, opts.slug, opts.name, opts.description, opts.helpText,
      JSON.stringify(opts.triggerExamples), opts.builtIn ? 1 : 0,
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
