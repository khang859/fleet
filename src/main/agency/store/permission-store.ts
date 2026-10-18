import type Database from 'better-sqlite3';
import {
  OPEN_PERMISSION_STATES,
  type AgencyPermission,
  type PermissionAnsweredBy,
  type PermissionDecision,
  type PermissionState
} from '../../../shared/agency-permissions';

/** A permission request with the session that asked it, which only main needs. */
export type PermissionRecord = AgencyPermission & { sessionId: string; toolUseId: string };

type PermissionRow = {
  id: number;
  job_id: number;
  crew_id: number;
  crew_label: string | null;
  step_id: string;
  session_id: string;
  tool_use_id: string;
  tool: string;
  target: string;
  state: PermissionState;
  answered_by: PermissionAnsweredBy | null;
  reason: string;
  summary: string | null;
  recommend: PermissionDecision | null;
  created_at: number;
  asked_at: number | null;
  expires_at: number | null;
  answered_at: number | null;
};

const SELECT = `SELECT p.*, c.label AS crew_label FROM permission_requests p
  LEFT JOIN crew_members c ON c.id = p.crew_id`;

const OPEN = `(${OPEN_PERMISSION_STATES.map((s) => `'${s}'`).join(', ')})`;

function toPermission(row: PermissionRow): PermissionRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    crewId: row.crew_id,
    crewLabel: row.crew_label ?? 'crew',
    stepId: row.step_id,
    sessionId: row.session_id,
    toolUseId: row.tool_use_id,
    tool: row.tool,
    target: row.target,
    state: row.state,
    answeredBy: row.answered_by,
    reason: row.reason,
    summary: row.summary,
    recommend: row.recommend,
    createdAt: row.created_at,
    askedAt: row.asked_at,
    expiresAt: row.expires_at,
    answeredAt: row.answered_at
  };
}

/**
 * Crew permission requests and their answers. A request moves only out of
 * an open state, so an answer that races another cannot overwrite it.
 */
export class PermissionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  insert(input: {
    jobId: number;
    crewId: number;
    stepId: string;
    sessionId: string;
    toolUseId: string;
    tool: string;
    target: string;
    state: 'admiral' | 'client';
  }): PermissionRecord {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO permission_requests (job_id, crew_id, step_id, session_id, tool_use_id, tool,
           target, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.jobId,
        input.crewId,
        input.stepId,
        input.sessionId,
        input.toolUseId,
        input.tool,
        input.target,
        input.state,
        this.now()
      );
    const request = this.get(Number(lastInsertRowid));
    if (!request) throw new Error('permission request vanished on insert');
    return request;
  }

  get(id: number): PermissionRecord | null {
    const row = this.db.prepare<[number], PermissionRow>(`${SELECT} WHERE p.id = ?`).get(id);
    return row ? toPermission(row) : null;
  }

  /** The open request a held hook carries. */
  openByToolUse(toolUseId: string): PermissionRecord | null {
    const row = this.db
      .prepare<
        [string],
        PermissionRow
      >(`${SELECT} WHERE p.tool_use_id = ? AND p.state IN ${OPEN} ORDER BY p.id DESC`)
      .get(toolUseId);
    return row ? toPermission(row) : null;
  }

  /** Every open request, or those of one session. */
  open(sessionId?: string): PermissionRecord[] {
    const rows =
      sessionId === undefined
        ? this.db
            .prepare<[], PermissionRow>(`${SELECT} WHERE p.state IN ${OPEN} ORDER BY p.id`)
            .all()
        : this.db
            .prepare<
              [string],
              PermissionRow
            >(`${SELECT} WHERE p.session_id = ? AND p.state IN ${OPEN} ORDER BY p.id`)
            .all(sessionId);
    return rows.map(toPermission);
  }

  /** Every request a job's crew made, oldest first. */
  forJob(jobId: number): PermissionRecord[] {
    return this.db
      .prepare<[number], PermissionRow>(`${SELECT} WHERE p.job_id = ? ORDER BY p.id`)
      .all(jobId)
      .map(toPermission);
  }

  /** A job's requests that wait on the client, on a card or in the crew pane, oldest first. */
  waitingOnClient(jobId: number): number[] {
    return this.db
      .prepare<[number], { id: number }>(
        `SELECT id FROM permission_requests WHERE job_id = ? AND state IN ('client', 'in_pane') ORDER BY id`
      )
      .all(jobId)
      .map((row) => row.id);
  }

  /** Whether a crew member waits on a permission answer. */
  crewWaiting(crewId: number): boolean {
    return (
      this.db
        .prepare<
          [number],
          { n: number }
        >(`SELECT COUNT(*) AS n FROM permission_requests WHERE crew_id = ? AND state IN ${OPEN}`)
        .get(crewId)?.n !== 0
    );
  }

  /** Put a request waiting on the Admiral to the client, with why and until when. */
  askClient(
    id: number,
    input: {
      reason: string;
      summary: string | null;
      recommend: PermissionDecision | null;
      expiresAt: number;
    }
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE permission_requests SET state = 'client', reason = ?, summary = ?, recommend = ?,
             asked_at = ?, expires_at = ? WHERE id = ? AND state = 'admiral'`
        )
        .run(input.reason, input.summary, input.recommend, this.now(), input.expiresAt, id)
        .changes > 0
    );
  }

  /** Record the answer an open request got. */
  answer(
    id: number,
    input: { decision: PermissionDecision; by: PermissionAnsweredBy; reason: string }
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE permission_requests SET state = ?, answered_by = ?, reason = ?, answered_at = ?
             WHERE id = ? AND state IN ${OPEN}`
        )
        .run(
          input.decision === 'allow' ? 'allowed' : 'denied',
          input.by,
          input.reason,
          this.now(),
          id
        ).changes > 0
    );
  }

  /** Fleet stopped holding an open request, so it waits in the crew pane. */
  inPane(id: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE permission_requests SET state = 'in_pane' WHERE id = ? AND state IN ('admiral', 'client')`
        )
        .run(id).changes > 0
    );
  }

  /** An open request went away without an answer through Fleet. */
  void(id: number, reason: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE permission_requests SET state = 'void', reason = ?, answered_at = ?
             WHERE id = ? AND state IN ${OPEN}`
        )
        .run(reason, this.now(), id).changes > 0
    );
  }
}
