import type Database from 'better-sqlite3';

export type ShipsLogRow = {
  id: number;
  crew_id: string | null;
  event_type: string;
  detail: string | null;
  created_at: string;
};

type LogOpts = {
  crewId?: string;
  eventType: string;
  detail?: unknown;
};

type QueryOpts = {
  crewId?: string;
  eventType?: string;
  since?: string;
  limit?: number;
};

export class ShipsLog {
  constructor(private db: Database.Database) {}

  log(opts: LogOpts): number {
    const detail = opts.detail !== undefined ? JSON.stringify(opts.detail) : null;
    const result = this.db
      .prepare('INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, ?, ?)')
      .run(opts.crewId ?? null, opts.eventType, detail);
    return result.lastInsertRowid as number;
  }

  query(opts: QueryOpts): ShipsLogRow[] {
    let sql = 'SELECT * FROM ships_log WHERE 1=1';
    const params: unknown[] = [];

    if (opts.crewId) {
      sql += ' AND crew_id = ?';
      params.push(opts.crewId);
    }
    if (opts.eventType) {
      sql += ' AND event_type = ?';
      params.push(opts.eventType);
    }
    if (opts.since) {
      sql += ' AND created_at >= ?';
      params.push(opts.since);
    }

    sql += ' ORDER BY created_at DESC';

    if (opts.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    return this.db.prepare(sql).all(...params) as ShipsLogRow[];
  }

  getRecent(limit: number): ShipsLogRow[] {
    return this.db
      .prepare('SELECT * FROM ships_log ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as ShipsLogRow[];
  }
}
