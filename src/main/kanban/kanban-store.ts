import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

const log = createLogger('kanban-store');

export interface KanbanStoreOptions {
  now?: () => number;
}

export class KanbanStore {
  protected db: Database.Database;
  protected now: () => number;

  constructor(dbPath: string, opts: KanbanStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    log.info('kanban store opened', { dbPath });
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  schemaVersion(): number {
    const row = this.db.pragma('user_version', { simple: true });
    return Number(row);
  }

  close(): void {
    this.db.close();
  }
}
