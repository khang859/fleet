import type Database from 'better-sqlite3';
import { CONFIG_DEFAULTS } from './migrations';

export class ConfigService {
  constructor(private db: Database.Database) {}

  get(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM starbase_config WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (row) {
      return JSON.parse(row.value);
    }
    return CONFIG_DEFAULTS[key];
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO starbase_config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      )
      .run(key, JSON.stringify(value));
  }

  getAll(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM starbase_config').all() as {
      key: string;
      value: string;
    }[];

    const result: Record<string, unknown> = { ...CONFIG_DEFAULTS };
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value);
    }
    return result;
  }
}
