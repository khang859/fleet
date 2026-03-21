import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { MIGRATIONS, CONFIG_DEFAULTS } from './migrations';

type IndexEntry = { workspacePath: string; starbaseId: string; dbPath: string };
type IndexFile = { starbases: IndexEntry[] };

export class StarbaseDB {
  private db: Database.Database | null = null;
  private starbaseId: string;
  private dbPath: string;
  private basePath: string;

  constructor(
    private workspacePath: string,
    basePath?: string,
  ) {
    this.basePath = basePath ?? join(process.env.HOME ?? '~', '.fleet', 'starbases');
    this.starbaseId = createHash('sha256').update(workspacePath).digest('hex').slice(0, 6);
    this.dbPath = join(this.basePath, `starbase-${this.starbaseId}.db`);
  }

  open(): void {
    mkdirSync(this.basePath, { recursive: true });

    // Integrity check for existing DB
    if (existsSync(this.dbPath)) {
      try {
        const testDb = new Database(this.dbPath);
        const result: unknown = testDb.pragma('integrity_check');
        testDb.close();
        const ok = Array.isArray(result) &&
          result.length > 0 &&
          typeof result[0] === 'object' &&
          result[0] !== null &&
          'integrity_check' in result[0] &&
          result[0].integrity_check === 'ok';
        if (!ok) {
          throw new Error('Integrity check failed');
        }
      } catch {
        const corruptPath = this.dbPath + '.corrupt';
        renameSync(this.dbPath, corruptPath);
      }
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    this.runMigrations();
    this.updateIndex();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  getDb(): Database.Database {
    if (!this.db) throw new Error('Database not open');
    return this.db;
  }

  getStarbaseId(): string {
    return this.starbaseId;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  private runMigrations(): void {
    const db = this.getDb();

    // Check if _meta exists
    const metaExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_meta'")
      .get();

    let currentVersion = 0;
    if (metaExists) {
      const meta = db.prepare<[], { schema_version: number }>('SELECT schema_version FROM _meta').get();
      currentVersion = meta?.schema_version ?? 0;
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;

      const runMigration = db.transaction(() => {
        db.exec(migration.sql);

        if (currentVersion === 0 && !metaExists) {
          // First migration — insert _meta row
          db.prepare('INSERT INTO _meta (schema_version, workspace_path) VALUES (?, ?)').run(
            migration.version,
            this.workspacePath,
          );
          // Seed config defaults
          const insertConfig = db.prepare(
            "INSERT OR IGNORE INTO starbase_config (key, value) VALUES (?, ?)",
          );
          for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
            insertConfig.run(key, JSON.stringify(value));
          }
        } else {
          db.prepare('UPDATE _meta SET schema_version = ?').run(migration.version);
        }
      });

      runMigration();
      currentVersion = migration.version;
    }
  }

  private updateIndex(): void {
    const indexPath = join(this.basePath, 'index.json');
    let index: IndexFile = { starbases: [] };

    if (existsSync(indexPath)) {
      try {
        index = JSON.parse(readFileSync(indexPath, 'utf-8'));
      } catch {
        index = { starbases: [] };
      }
    }

    // Update or add entry
    const existing = index.starbases.find((e) => e.starbaseId === this.starbaseId);
    if (existing) {
      existing.workspacePath = this.workspacePath;
      existing.dbPath = this.dbPath;
    } else {
      index.starbases.push({
        workspacePath: this.workspacePath,
        starbaseId: this.starbaseId,
        dbPath: this.dbPath,
      });
    }

    // Atomic write
    const tmpPath = indexPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(index, null, 2));
    renameSync(tmpPath, indexPath);
  }
}
