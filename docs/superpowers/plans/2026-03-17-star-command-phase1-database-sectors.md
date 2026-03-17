# Star Command Phase 1: Database + Sector Registry — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an embedded SQLite database per Starbase with the full Star Command schema, plus Sector CRUD operations accessible from main process, IPC, and socket API.

**Architecture:** `better-sqlite3` provides synchronous SQLite access in the main process. `StarbaseDB` manages database lifecycle (open, migrate, close). Service classes (`SectorService`, `ConfigService`) operate on the database. IPC handlers and socket commands expose operations to the renderer and external tools.

**Tech Stack:** better-sqlite3, Electron IPC, existing SocketApi

**Spec:** `docs/superpowers/specs/2026-03-17-star-command-phase1-database-sectors.md`

---

## File Structure

**New files:**
- `src/main/starbase/db.ts` — StarbaseDB class: open/create database, run migrations, manage index.json
- `src/main/starbase/migrations.ts` — Migration runner + migration SQL strings (hardcoded array, not file-based)
- `src/main/starbase/sector-service.ts` — Sector CRUD: add, remove, update, list, get
- `src/main/starbase/config-service.ts` — Key-value config store with typed defaults
- `src/main/__tests__/starbase-db.test.ts` — StarbaseDB unit tests
- `src/main/__tests__/sector-service.test.ts` — SectorService unit tests
- `src/main/__tests__/config-service.test.ts` — ConfigService unit tests

**Modified files:**
- `package.json` — Add `better-sqlite3` and `@types/better-sqlite3`
- `src/shared/constants.ts` — Add Starbase IPC channel constants
- `src/shared/ipc-api.ts` — Add Starbase-related payload types
- `src/main/ipc-handlers.ts` — Register starbase IPC handlers
- `src/main/socket-command-handler.ts` — Add starbase socket commands
- `src/main/index.ts` — Initialize StarbaseDB and services on app start

---

## Chunk 1: Dependencies + StarbaseDB Core

### Task 1: Install better-sqlite3

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install better-sqlite3 and types**

```bash
cd /Users/khangnguyen/Development/fleet && npm install better-sqlite3 && npm install -D @types/better-sqlite3
```

- [ ] **Step 2: Verify installation**

```bash
npm ls better-sqlite3
```

Expected: `better-sqlite3@x.x.x` listed without errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3 for Star Command database"
```

---

### Task 2: Write StarbaseDB — migration runner + open/close

**Files:**
- Create: `src/main/starbase/migrations.ts`
- Create: `src/main/starbase/db.ts`
- Create: `src/main/__tests__/starbase-db.test.ts`

- [ ] **Step 1: Write failing test for StarbaseDB.open()**

In `src/main/__tests__/starbase-db.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-starbase');

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('StarbaseDB', () => {
  it('should create a database and run migrations', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const workspacePath = '/tmp/test-workspace';
    const db = new StarbaseDB(workspacePath, TEST_DIR);
    db.open();

    // Verify database file exists
    const files = require('fs').readdirSync(TEST_DIR);
    expect(files.some((f: string) => f.endsWith('.db'))).toBe(true);

    // Verify schema_version is set
    const raw = db.getDb();
    const meta = raw.prepare('SELECT schema_version FROM _meta').get() as { schema_version: number };
    expect(meta.schema_version).toBe(1);

    // Verify sectors table exists
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('sectors');
    expect(tableNames).toContain('missions');
    expect(tableNames).toContain('crew');
    expect(tableNames).toContain('comms');
    expect(tableNames).toContain('cargo');
    expect(tableNames).toContain('ships_log');
    expect(tableNames).toContain('starbase_config');

    db.close();
  });

  it('should derive consistent starbase ID from workspace path', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const db1 = new StarbaseDB('/tmp/workspace-a', TEST_DIR);
    const db2 = new StarbaseDB('/tmp/workspace-a', TEST_DIR);
    expect(db1.getStarbaseId()).toBe(db2.getStarbaseId());

    const db3 = new StarbaseDB('/tmp/workspace-b', TEST_DIR);
    expect(db1.getStarbaseId()).not.toBe(db3.getStarbaseId());
  });

  it('should reopen an existing database without re-running migrations', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const workspacePath = '/tmp/test-workspace';

    const db1 = new StarbaseDB(workspacePath, TEST_DIR);
    db1.open();
    const id1 = db1.getStarbaseId();
    db1.close();

    const db2 = new StarbaseDB(workspacePath, TEST_DIR);
    db2.open();
    const id2 = db2.getStarbaseId();
    expect(id2).toBe(id1);

    // Schema version still 1 (not re-incremented)
    const raw = db2.getDb();
    const meta = raw.prepare('SELECT schema_version FROM _meta').get() as { schema_version: number };
    expect(meta.schema_version).toBe(1);
    db2.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/starbase-db.test.ts
```

Expected: FAIL — `StarbaseDB` not found.

- [ ] **Step 3: Write migrations module**

Create `src/main/starbase/migrations.ts`:

```typescript
export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001-initial',
    sql: `
      CREATE TABLE IF NOT EXISTS _meta (
        schema_version INTEGER NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sectors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT UNIQUE NOT NULL,
        stack TEXT,
        description TEXT,
        base_branch TEXT DEFAULT 'main',
        merge_strategy TEXT DEFAULT 'pr',
        verify_command TEXT,
        lint_command TEXT,
        review_mode TEXT DEFAULT 'admiral-review',
        worktree_enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS supply_routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upstream_sector_id TEXT NOT NULL REFERENCES sectors(id),
        downstream_sector_id TEXT NOT NULL REFERENCES sectors(id),
        relationship TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS missions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sector_id TEXT NOT NULL REFERENCES sectors(id),
        crew_id TEXT,
        summary TEXT NOT NULL,
        prompt TEXT NOT NULL,
        acceptance_criteria TEXT,
        status TEXT DEFAULT 'queued',
        priority INTEGER DEFAULT 0,
        depends_on_mission_id INTEGER REFERENCES missions(id),
        result TEXT,
        verify_result TEXT,
        review_verdict TEXT,
        review_notes TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        started_at DATETIME,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS crew (
        id TEXT PRIMARY KEY,
        tab_id TEXT,
        sector_id TEXT NOT NULL REFERENCES sectors(id),
        mission_id INTEGER REFERENCES missions(id),
        sector_path TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        status TEXT DEFAULT 'active',
        mission_summary TEXT,
        avatar_variant TEXT,
        pid INTEGER,
        deadline DATETIME,
        token_budget INTEGER DEFAULT 0,
        tokens_used INTEGER DEFAULT 0,
        last_lifesign DATETIME,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS comms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_crew TEXT,
        to_crew TEXT,
        thread_id TEXT,
        in_reply_to INTEGER REFERENCES comms(id),
        type TEXT,
        payload TEXT,
        read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cargo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_id TEXT,
        mission_id INTEGER REFERENCES missions(id),
        sector_id TEXT NOT NULL REFERENCES sectors(id),
        type TEXT,
        manifest TEXT,
        verified INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ships_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_id TEXT,
        event_type TEXT NOT NULL,
        detail TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS starbase_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT (datetime('now'))
      );
    `,
  },
];

export const CONFIG_DEFAULTS: Record<string, unknown> = {
  max_concurrent_worktrees: 5,
  worktree_pool_size: 2,
  worktree_disk_budget_gb: 5,
  default_mission_timeout_min: 15,
  default_merge_strategy: 'pr',
  comms_rate_limit_per_min: 30,
  default_token_budget: 0,
  lifesign_interval_sec: 10,
  lifesign_timeout_sec: 30,
  default_review_mode: 'admiral-review',
  review_timeout_min: 10,
};
```

- [ ] **Step 4: Write StarbaseDB class**

Create `src/main/starbase/db.ts`:

```typescript
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
        const result = testDb.pragma('integrity_check') as { integrity_check: string }[];
        testDb.close();
        if (result[0]?.integrity_check !== 'ok') {
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
      const meta = db.prepare('SELECT schema_version FROM _meta').get() as
        | { schema_version: number }
        | undefined;
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/starbase-db.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/db.ts src/main/starbase/migrations.ts src/main/__tests__/starbase-db.test.ts
git commit -m "feat(starbase): add StarbaseDB with migration runner and schema"
```

---

## Chunk 2: SectorService

### Task 3: Write SectorService with CRUD operations

**Files:**
- Create: `src/main/starbase/sector-service.ts`
- Create: `src/main/__tests__/sector-service.test.ts`

- [ ] **Step 1: Write failing tests for SectorService**

In `src/main/__tests__/sector-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { SectorService } from '../starbase/sector-service';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-sectors');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let svc: SectorService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  // Create a dummy file so sector dir has content
  require('fs').writeFileSync(join(SECTOR_DIR, 'index.ts'), '');
  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();
  svc = new SectorService(db.getDb(), WORKSPACE_DIR);
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('SectorService', () => {
  it('should add a sector', () => {
    const sector = svc.addSector({ path: 'api' });
    expect(sector.id).toBe('api');
    expect(sector.name).toBe('api');
    expect(sector.root_path).toBe(SECTOR_DIR);
  });

  it('should reject duplicate sectors', () => {
    svc.addSector({ path: 'api' });
    expect(() => svc.addSector({ path: 'api' })).toThrow('already registered');
  });

  it('should reject non-existent directories', () => {
    expect(() => svc.addSector({ path: 'nonexistent' })).toThrow();
  });

  it('should list sectors', () => {
    svc.addSector({ path: 'api' });
    const list = svc.listSectors();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('api');
  });

  it('should get a sector by id', () => {
    svc.addSector({ path: 'api' });
    const sector = svc.getSector('api');
    expect(sector).toBeDefined();
    expect(sector!.name).toBe('api');
  });

  it('should remove a sector', () => {
    svc.addSector({ path: 'api' });
    svc.removeSector('api');
    expect(svc.listSectors()).toHaveLength(0);
  });

  it('should update a sector', () => {
    svc.addSector({ path: 'api' });
    svc.updateSector('api', { description: 'API service', base_branch: 'develop' });
    const sector = svc.getSector('api');
    expect(sector!.description).toBe('API service');
    expect(sector!.base_branch).toBe('develop');
  });

  it('should auto-detect stack from package.json', () => {
    require('fs').writeFileSync(join(SECTOR_DIR, 'package.json'), '{}');
    const sector = svc.addSector({ path: 'api' });
    expect(sector.stack).toBe('typescript/node');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/sector-service.test.ts
```

Expected: FAIL — `SectorService` not found.

- [ ] **Step 3: Write SectorService implementation**

Create `src/main/starbase/sector-service.ts`:

```typescript
import type Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';

export class SectorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SectorValidationError';
  }
}

type SectorRow = {
  id: string;
  name: string;
  root_path: string;
  stack: string | null;
  description: string | null;
  base_branch: string;
  merge_strategy: string;
  verify_command: string | null;
  lint_command: string | null;
  review_mode: string;
  worktree_enabled: number;
  created_at: string;
  updated_at: string;
};

type AddSectorOpts = {
  path: string;
  name?: string;
  description?: string;
  baseBranch?: string;
  mergeStrategy?: string;
};

type UpdateSectorFields = {
  name?: string;
  description?: string;
  base_branch?: string;
  merge_strategy?: string;
  verify_command?: string | null;
  lint_command?: string | null;
  review_mode?: string;
  worktree_enabled?: boolean;
};

export class SectorService {
  constructor(
    private db: Database.Database,
    private workspaceRoot: string,
  ) {}

  addSector(opts: AddSectorOpts): SectorRow {
    const absolutePath = resolve(this.workspaceRoot, opts.path);

    if (!existsSync(absolutePath)) {
      throw new SectorValidationError(`Directory does not exist: ${absolutePath}`);
    }

    const entries = readdirSync(absolutePath);
    if (entries.length === 0) {
      throw new SectorValidationError(`Directory is empty: ${absolutePath}`);
    }

    // Check for duplicate root_path
    const existing = this.db
      .prepare('SELECT id FROM sectors WHERE root_path = ?')
      .get(absolutePath) as { id: string } | undefined;
    if (existing) {
      throw new SectorValidationError(
        `Path already registered as sector '${existing.id}'`,
      );
    }

    const id = this.generateSlugId(absolutePath);
    const name = opts.name ?? basename(absolutePath);
    const stack = this.detectStack(absolutePath);

    this.db
      .prepare(
        `INSERT INTO sectors (id, name, root_path, stack, description, base_branch, merge_strategy)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        absolutePath,
        stack,
        opts.description ?? null,
        opts.baseBranch ?? 'main',
        opts.mergeStrategy ?? 'pr',
      );

    return this.getSector(id)!;
  }

  removeSector(sectorId: string): void {
    const result = this.db.prepare('DELETE FROM sectors WHERE id = ?').run(sectorId);
    if (result.changes === 0) {
      throw new SectorValidationError(`Sector not found: ${sectorId}`);
    }
  }

  updateSector(sectorId: string, fields: UpdateSectorFields): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(key === 'worktree_enabled' ? (value ? 1 : 0) : value);
      }
    }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    values.push(sectorId);

    this.db
      .prepare(`UPDATE sectors SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  getSector(sectorId: string): SectorRow | undefined {
    return this.db.prepare('SELECT * FROM sectors WHERE id = ?').get(sectorId) as
      | SectorRow
      | undefined;
  }

  listSectors(): SectorRow[] {
    return this.db.prepare('SELECT * FROM sectors ORDER BY name').all() as SectorRow[];
  }

  private generateSlugId(absolutePath: string): string {
    const base = basename(absolutePath).toLowerCase().replace(/[^a-z0-9]/g, '-');
    // Check for collision
    const existing = this.db.prepare('SELECT id FROM sectors WHERE id = ?').get(base);
    if (!existing) return base;

    // Append parent directory name as prefix
    const parent = basename(dirname(absolutePath)).toLowerCase().replace(/[^a-z0-9]/g, '-');
    const prefixed = `${parent}-${base}`;
    const existingPrefixed = this.db.prepare('SELECT id FROM sectors WHERE id = ?').get(prefixed);
    if (!existingPrefixed) return prefixed;

    // Last resort: append numeric suffix
    let counter = 2;
    while (this.db.prepare('SELECT id FROM sectors WHERE id = ?').get(`${prefixed}-${counter}`)) {
      counter++;
    }
    return `${prefixed}-${counter}`;
  }

  private detectStack(dirPath: string): string | null {
    const entries = readdirSync(dirPath);
    if (entries.includes('package.json')) return 'typescript/node';
    if (entries.includes('go.mod')) return 'go';
    if (entries.includes('Cargo.toml')) return 'rust';
    if (entries.includes('pyproject.toml') || entries.includes('requirements.txt')) return 'python';
    if (entries.includes('Gemfile')) return 'ruby';
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/sector-service.test.ts
```

Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/sector-service.ts src/main/__tests__/sector-service.test.ts
git commit -m "feat(starbase): add SectorService with CRUD and stack detection"
```

---

## Chunk 3: ConfigService

### Task 4: Write ConfigService

**Files:**
- Create: `src/main/starbase/config-service.ts`
- Create: `src/main/__tests__/config-service.test.ts`

- [ ] **Step 1: Write failing tests for ConfigService**

In `src/main/__tests__/config-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { ConfigService } from '../starbase/config-service';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-config');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let svc: ConfigService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new StarbaseDB('/tmp/config-test', DB_DIR);
  db.open();
  svc = new ConfigService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ConfigService', () => {
  it('should return seeded defaults via get()', () => {
    expect(svc.get('max_concurrent_worktrees')).toBe(5);
    expect(svc.get('default_mission_timeout_min')).toBe(15);
  });

  it('should set and get a value', () => {
    svc.set('max_concurrent_worktrees', 10);
    expect(svc.get('max_concurrent_worktrees')).toBe(10);
  });

  it('should return all config with defaults', () => {
    const all = svc.getAll();
    expect(all.max_concurrent_worktrees).toBe(5);
    expect(all.lifesign_timeout_sec).toBe(30);
  });

  it('should handle unknown keys with fallback to CONFIG_DEFAULTS', () => {
    // If a key is not in the DB but is in defaults, return default
    expect(svc.get('default_review_mode')).toBe('admiral-review');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/config-service.test.ts
```

Expected: FAIL — `ConfigService` not found.

- [ ] **Step 3: Write ConfigService implementation**

Create `src/main/starbase/config-service.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/config-service.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/config-service.ts src/main/__tests__/config-service.test.ts
git commit -m "feat(starbase): add ConfigService with typed defaults"
```

---

## Chunk 4: IPC + Socket Integration

### Task 5: Add IPC channel constants and types

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/constants.ts`, add to the `IPC_CHANNELS` object:

```typescript
STARBASE_LIST_SECTORS: 'starbase:list-sectors',
STARBASE_ADD_SECTOR: 'starbase:add-sector',
STARBASE_REMOVE_SECTOR: 'starbase:remove-sector',
STARBASE_UPDATE_SECTOR: 'starbase:update-sector',
STARBASE_GET_CONFIG: 'starbase:get-config',
STARBASE_SET_CONFIG: 'starbase:set-config',
```

- [ ] **Step 2: Add IPC payload types**

In `src/shared/ipc-api.ts`, add:

```typescript
export type SectorPayload = {
  id: string;
  name: string;
  root_path: string;
  stack: string | null;
  description: string | null;
  base_branch: string;
  merge_strategy: string;
  verify_command: string | null;
  lint_command: string | null;
  review_mode: string;
  worktree_enabled: number;
};

export type AddSectorRequest = {
  path: string;
  name?: string;
  description?: string;
  baseBranch?: string;
  mergeStrategy?: string;
};

export type UpdateSectorRequest = {
  sectorId: string;
  fields: Record<string, unknown>;
};

export type SetConfigRequest = {
  key: string;
  value: unknown;
};
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants.ts src/shared/ipc-api.ts
git commit -m "feat(starbase): add IPC channel constants and payload types"
```

---

### Task 6: Register IPC handlers and socket commands

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/socket-command-handler.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add starbase IPC handlers**

In `src/main/ipc-handlers.ts`, add a new registration function (or extend the existing one). The function should accept `SectorService` and `ConfigService` as parameters. Register these handlers:

```typescript
ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_SECTORS, () => sectorService.listSectors());
ipcMain.handle(IPC_CHANNELS.STARBASE_ADD_SECTOR, (_e, req) => sectorService.addSector(req));
ipcMain.handle(IPC_CHANNELS.STARBASE_REMOVE_SECTOR, (_e, { sectorId }) => sectorService.removeSector(sectorId));
ipcMain.handle(IPC_CHANNELS.STARBASE_UPDATE_SECTOR, (_e, { sectorId, fields }) => sectorService.updateSector(sectorId, fields));
ipcMain.handle(IPC_CHANNELS.STARBASE_GET_CONFIG, () => configService.getAll());
ipcMain.handle(IPC_CHANNELS.STARBASE_SET_CONFIG, (_e, { key, value }) => configService.set(key, value));
```

- [ ] **Step 2: Add socket commands for starbase**

In `src/main/socket-command-handler.ts`, add cases to `handleCommand`:

```typescript
case 'sectors':
  return { ok: true, sectors: sectorService.listSectors() };
case 'add-sector':
  return { ok: true, sector: sectorService.addSector(cmd as any) };
case 'config-get':
  if (cmd.key) {
    return { ok: true, key: cmd.key, value: configService.get(cmd.key as string) };
  }
  return { ok: true, config: configService.getAll() };
case 'config-set':
  configService.set(cmd.key as string, cmd.value);
  return { ok: true };
```

- [ ] **Step 3: Initialize StarbaseDB and services in main process**

In `src/main/index.ts`, after the existing imports, add:

```typescript
import { StarbaseDB } from './starbase/db';
import { SectorService } from './starbase/sector-service';
import { ConfigService } from './starbase/config-service';
```

In the `app.whenReady().then(...)` block, after the existing `const gitService = new GitService()`:

```typescript
// Initialize Star Command database
let starbaseDb: StarbaseDB | null = null;
let sectorService: SectorService | null = null;
let configService: ConfigService | null = null;

try {
  const workspacePath = layoutStore.getCurrentWorkspacePath() ?? process.cwd();
  starbaseDb = new StarbaseDB(workspacePath);
  starbaseDb.open();
  sectorService = new SectorService(starbaseDb.getDb(), workspacePath);
  configService = new ConfigService(starbaseDb.getDb());
} catch (err) {
  console.error('[starbase] Failed to initialize Star Command database:', err);
}
```

Pass `sectorService` and `configService` to the IPC handler registration and socket command handler.

- [ ] **Step 4: Run the full test suite to verify nothing is broken**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run
```

Expected: All existing tests pass, plus the new starbase tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/socket-command-handler.ts src/main/index.ts
git commit -m "feat(starbase): wire IPC handlers and socket commands for sectors and config"
```

---

### Task 7: Run full test suite and verify typecheck

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

```bash
cd /Users/khangnguyen/Development/fleet && npm run typecheck
```

Expected: No type errors.

- [ ] **Step 2: Run all tests**

```bash
cd /Users/khangnguyen/Development/fleet && npm test
```

Expected: All tests pass.

- [ ] **Step 3: Run lint**

```bash
cd /Users/khangnguyen/Development/fleet && npm run lint
```

Expected: No lint errors (or only pre-existing ones).
