import type Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import type { EventBus } from '../event-bus';

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
  model: string | null;
  system_prompt: string | null;
  allowed_tools: string | null;
  mcp_config: string | null;
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
  model?: string | null;
  system_prompt?: string | null;
  allowed_tools?: string | null;
  mcp_config?: string | null;
};

export class SectorService {
  constructor(
    private db: Database.Database,
    private workspaceRoot: string,
    private eventBus?: EventBus
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
      .prepare<[string], { id: string }>('SELECT id FROM sectors WHERE root_path = ?')
      .get(absolutePath);
    if (existing) {
      throw new SectorValidationError(`Path already registered as sector '${existing.id}'`);
    }

    const id = this.generateSlugId(absolutePath);
    const name = opts.name ?? basename(absolutePath);
    const stack = this.detectStack(absolutePath);

    this.db
      .prepare(
        `INSERT INTO sectors (id, name, root_path, stack, description, base_branch, merge_strategy)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        name,
        absolutePath,
        stack,
        opts.description ?? null,
        opts.baseBranch ?? 'main',
        opts.mergeStrategy ?? 'pr'
      );

    const sector = this.getSector(id);
    if (!sector) throw new SectorValidationError(`Failed to retrieve inserted sector: ${id}`);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    return sector;
  }

  removeSector(sectorId: string): void {
    const result = this.db.prepare('DELETE FROM sectors WHERE id = ?').run(sectorId);
    if (result.changes === 0) {
      throw new SectorValidationError(`Sector not found: ${sectorId}`);
    }
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  updateSector(sectorId: string, fields: UpdateSectorFields): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      values.push(key === 'worktree_enabled' ? (value ? 1 : 0) : value);
    }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    values.push(sectorId);

    this.db.prepare(`UPDATE sectors SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  getSector(sectorId: string): SectorRow | undefined {
    return this.db.prepare<[string], SectorRow>('SELECT * FROM sectors WHERE id = ?').get(sectorId);
  }

  listSectors(): SectorRow[] {
    return this.db.prepare<[], SectorRow>('SELECT * FROM sectors ORDER BY name').all();
  }

  listVisibleSectors(): SectorRow[] {
    return this.db
      .prepare<[string], SectorRow>('SELECT * FROM sectors WHERE id != ? ORDER BY name')
      .all(GLOBAL_SECTOR_ID);
  }

  isLogicalSector(sectorId: string): boolean {
    return sectorId === GLOBAL_SECTOR_ID;
  }

  private generateSlugId(absolutePath: string): string {
    const base = basename(absolutePath)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-');
    // Check for collision
    const existing = this.db.prepare('SELECT id FROM sectors WHERE id = ?').get(base);
    if (!existing) return base;

    // Append parent directory name as prefix
    const parent = basename(dirname(absolutePath))
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-');
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

export const GLOBAL_SECTOR_ID = 'global';
