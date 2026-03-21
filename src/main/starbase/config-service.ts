import type Database from 'better-sqlite3';
import { CONFIG_DEFAULTS } from './migrations';

export class ConfigService {
  constructor(private db: Database.Database) {}

  get(key: string): unknown {
    const row = this.db.prepare<[string], { value: string }>('SELECT value FROM starbase_config WHERE key = ?').get(key);
    if (row) {
      return JSON.parse(row.value);
    }
    return CONFIG_DEFAULTS[key];
  }

  getNumber(key: string): number {
    const val = this.get(key);
    if (typeof val !== 'number') throw new Error(`Config '${key}' is not a number`);
    return val;
  }

  getString(key: string): string {
    const val = this.get(key);
    if (typeof val !== 'string') throw new Error(`Config '${key}' is not a string`);
    return val;
  }

  getOptionalString(key: string): string | undefined {
    const val = this.get(key);
    return typeof val === 'string' ? val : undefined;
  }

  getOptionalBoolean(key: string): boolean | undefined {
    const val = this.get(key);
    return typeof val === 'boolean' ? val : undefined;
  }

  getBoolean(key: string): boolean {
    const val = this.get(key);
    if (typeof val !== 'boolean') throw new Error(`Config '${key}' is not a boolean`);
    return val;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO starbase_config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      )
      .run(key, JSON.stringify(value));
  }

  getAll(): Record<string, unknown> {
    const rows = this.db.prepare<[], { key: string; value: string }>('SELECT key, value FROM starbase_config').all();

    const result: Record<string, unknown> = { ...CONFIG_DEFAULTS };
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value);
    }
    return result;
  }
}
