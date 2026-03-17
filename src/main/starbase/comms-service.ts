import type Database from 'better-sqlite3';

export type TransmissionRow = {
  id: number;
  from_crew: string | null;
  to_crew: string | null;
  thread_id: string | null;
  in_reply_to: number | null;
  type: string;
  payload: string;
  read: number;
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
  constructor(private db: Database.Database) {}

  send(opts: SendOpts): number {
    const result = this.db
      .prepare(
        'INSERT INTO comms (from_crew, to_crew, type, payload, thread_id, in_reply_to) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(opts.from, opts.to, opts.type, opts.payload, opts.threadId ?? null, opts.inReplyTo ?? null);
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

  getRecent(opts?: { crewId?: string; limit?: number }): TransmissionRow[] {
    const limit = opts?.limit ?? 50;
    if (opts?.crewId) {
      return this.db
        .prepare(
          'SELECT * FROM comms WHERE from_crew = ? OR to_crew = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(opts.crewId, opts.crewId, limit) as TransmissionRow[];
    }
    return this.db
      .prepare('SELECT * FROM comms ORDER BY created_at DESC LIMIT ?')
      .all(limit) as TransmissionRow[];
  }
}
