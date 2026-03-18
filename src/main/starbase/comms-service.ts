import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus';

export class CommsRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommsRateLimitError';
  }
}

export type TransmissionRow = {
  id: number;
  from_crew: string | null;
  to_crew: string | null;
  thread_id: string | null;
  in_reply_to: number | null;
  type: string;
  payload: string;
  read: number;
  repeat_count: number;
  last_repeated_at: string | null;
  created_at: string;
};

type SendOpts = {
  from: string;
  to: string;
  type: string;
  payload: string;
  threadId?: string;
  inReplyTo?: number;
};

export class CommsService {
  private rateLimit: number = 0; // 0 = disabled

  constructor(
    private db: Database.Database,
    private eventBus?: EventBus,
  ) {}

  /** Set the per-minute rate limit per crew. 0 = disabled. */
  setRateLimit(limit: number): void {
    this.rateLimit = limit;
  }

  send(opts: SendOpts): number {
    // Deduplicate: if an identical message exists within 5 minutes, bump its repeat_count
    // Admiral messages are never deduplicated — they are intentional commands
    // Dedup runs before rate limit so coalesced duplicates don't consume rate limit budget
    if (opts.from !== 'admiral') {
      const existing = this.db
        .prepare(
          `SELECT id FROM comms
           WHERE from_crew = ? AND to_crew = ? AND type = ? AND payload = ?
             AND created_at > datetime('now', '-5 minutes')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(opts.from, opts.to, opts.type, opts.payload) as { id: number } | undefined;

      if (existing) {
        this.db
          .prepare(
            `UPDATE comms SET repeat_count = repeat_count + 1, last_repeated_at = datetime('now') WHERE id = ?`,
          )
          .run(existing.id);
        this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
        return existing.id;
      }
    }

    // Check rate limit for the sender (after dedup, so coalesced messages don't count)
    if (this.rateLimit > 0 && opts.from !== 'admiral') {
      const row = this.db
        .prepare('SELECT comms_count_minute FROM crew WHERE id = ?')
        .get(opts.from) as { comms_count_minute: number } | undefined;

      if (row && row.comms_count_minute >= this.rateLimit) {
        // Log the rejection
        this.db.prepare(
          "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'comms_failed', ?)",
        ).run(opts.from, JSON.stringify({ reason: 'rate limit exceeded', limit: this.rateLimit }));
        throw new CommsRateLimitError(`Rate limit exceeded for ${opts.from}: ${row.comms_count_minute}/${this.rateLimit} per minute`);
      }

      // Increment counter
      if (row) {
        this.db
          .prepare('UPDATE crew SET comms_count_minute = comms_count_minute + 1 WHERE id = ?')
          .run(opts.from);
      }
    }

    const result = this.db
      .prepare(
        'INSERT INTO comms (from_crew, to_crew, type, payload, thread_id, in_reply_to) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(opts.from, opts.to, opts.type, opts.payload, opts.threadId ?? null, opts.inReplyTo ?? null);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    return result.lastInsertRowid as number;
  }

  resolve(transmissionId: number, response: string): number {
    const original = this.db.prepare('SELECT * FROM comms WHERE id = ?').get(transmissionId) as
      | TransmissionRow
      | undefined;
    if (!original) throw new Error(`Transmission not found: ${transmissionId}`);

    this.markRead(transmissionId);

    return this.send({
      from: original.to_crew ?? 'admiral',
      to: original.from_crew ?? 'unknown',
      type: 'directive',
      payload: response,
      threadId: original.thread_id ?? String(transmissionId),
      inReplyTo: transmissionId,
    });
  }

  getUnread(crewId: string): TransmissionRow[] {
    return this.db
      .prepare('SELECT * FROM comms WHERE to_crew = ? AND read = 0 ORDER BY created_at ASC')
      .all(crewId) as TransmissionRow[];
  }

  markRead(transmissionId: number): void {
    this.db.prepare('UPDATE comms SET read = 1 WHERE id = ?').run(transmissionId);
  }

  getThread(threadId: string): TransmissionRow[] {
    return this.db
      .prepare('SELECT * FROM comms WHERE thread_id = ? ORDER BY created_at ASC')
      .all(threadId) as TransmissionRow[];
  }

  delete(transmissionId: number): boolean {
    const result = this.db.prepare('DELETE FROM comms WHERE id = ?').run(transmissionId);
    if (result.changes > 0) {
      this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
      return true;
    }
    return false;
  }

  clear(opts?: { crewId?: string }): number {
    let result;
    if (opts?.crewId) {
      result = this.db
        .prepare('DELETE FROM comms WHERE from_crew = ? OR to_crew = ?')
        .run(opts.crewId, opts.crewId);
    } else {
      result = this.db.prepare('DELETE FROM comms').run();
    }
    if (result.changes > 0) {
      this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }
    return result.changes;
  }

  markAllRead(opts?: { crewId?: string }): number {
    let result;
    if (opts?.crewId) {
      result = this.db
        .prepare('UPDATE comms SET read = 1 WHERE to_crew = ? AND read = 0')
        .run(opts.crewId);
    } else {
      result = this.db.prepare('UPDATE comms SET read = 1 WHERE read = 0').run();
    }
    if (result.changes > 0) {
      this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }
    return result.changes;
  }

  getRecent(opts?: { crewId?: string; limit?: number; type?: string; from?: string }): TransmissionRow[] {
    if (opts?.crewId && opts?.from) {
      throw new Error('Cannot filter by both crewId and from — crewId already matches from_crew and to_crew');
    }

    const limit = opts?.limit ?? 50;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.crewId) {
      conditions.push('(from_crew = ? OR to_crew = ?)');
      params.push(opts.crewId, opts.crewId);
    }
    if (opts?.type) {
      conditions.push('type = ?');
      params.push(opts.type);
    }
    if (opts?.from) {
      conditions.push('from_crew = ?');
      params.push(opts.from);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    return this.db
      .prepare(`SELECT * FROM comms ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as TransmissionRow[];
  }
}
