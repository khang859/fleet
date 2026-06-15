import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger';
import type {
  Learning,
  CreateLearningInput,
  UpdateLearningInput,
  LearningSearchFilter,
  TagCount
} from '../../shared/learnings';
import type { SessionAgent } from '../../shared/sessions';
import { loadVecExtension } from './vec-extension';
import { EMBED_DIM } from './embedder';

const log = createLogger('learnings-store');

const SCHEMA_VERSION = 2;

/** A learning row that still needs an embedding (backfill / re-embed-on-edit). */
export type PendingEmbedding = { id: string; rowid: number; title: string; body: string };

/** One vector-search hit: the learning id and its distance to the query (lower = nearer). */
export type VecHit = { id: string; distance: number };

// FTS5 external-content index over the canonical `learnings` table. Triggers keep
// `learnings_fts` in sync on insert/update/delete, so store methods just do normal
// writes. content_rowid uses each row's implicit rowid (TEXT PRIMARY KEY does not
// alias rowid, so the implicit one is stable and available as `rowid` in triggers).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  source_agent TEXT,
  source_session_id TEXT,
  source_cwd TEXT,
  source_project TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learnings_created ON learnings(created_at);
CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(source_project);

CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
  title, body, content='learnings', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO learnings_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`;

/**
 * Turn user search text into a safe FTS5 MATCH expression (prefix-AND of tokens).
 * Returns '' when the text has no searchable tokens (e.g. punctuation-only input),
 * so callers can skip the MATCH entirely — handing FTS5 an empty phrase like `"."*`
 * makes it throw `fts5: syntax error`.
 */
function toFtsQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    // Drop tokens with no letter or digit: quoting them yields an empty FTS5
    // phrase, which FTS5 rejects as a syntax error.
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  // Quote each token (escaping embedded quotes) and add a prefix `*` so partial
  // words match. Quoting neutralizes FTS5 operators in user input.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

export interface LearningsStoreOptions {
  now?: () => number;
}

export class LearningsStore {
  private db: Database.Database;
  private now: () => number;
  /** True when the sqlite-vec extension loaded — gates all vector operations. */
  private vec = false;

  constructor(dbPath: string, opts: LearningsStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // Wait briefly instead of throwing SQLITE_BUSY when a second window/store
    // collides on a write while WAL is checkpointing.
    this.db.pragma('busy_timeout = 5000');
    // Vector search is an enhancement, not a hard dependency: if the extension
    // can't load (missing binary, unsupported platform) the store still works as a
    // keyword (FTS5) KB and every vector method becomes a no-op.
    try {
      loadVecExtension(this.db);
      this.vec = true;
    } catch (err) {
      log.warn('sqlite-vec unavailable; learnings KB will use keyword search only', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
    this.migrate();
    log.info('learnings store opened', { dbPath, vectorSearch: this.vec });
  }

  /** Whether semantic (vector) search is available on this store. */
  hasVectorSupport(): boolean {
    return this.vec;
  }

  private migrate(): void {
    // Read the schema version BEFORE any DDL. `CREATE ... IF NOT EXISTS` no-ops on
    // an existing DB, so a future migration that alters the FTS table or adds a
    // column must gate on the pre-DDL version (`from < N`) — not on whatever the
    // idempotent DDL leaves behind, which would make the migration silently skip.
    const from = Number(this.db.pragma('user_version', { simple: true }));
    this.db.exec(SCHEMA_SQL);
    // v2: semantic search. `embedding_updated_at` tracks embedding freshness
    // (NULL = needs (re-)embedding); `learnings_vec` holds the vectors. The vec0
    // table only exists when the extension loaded — guarded everywhere by `this.vec`.
    if (from < 2) {
      this.addColumnIfMissing('learnings', 'embedding_updated_at', 'INTEGER');
    }
    if (this.vec) {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS learnings_vec USING vec0(embedding float[${EMBED_DIM}])`
      );
    }
    if (from !== SCHEMA_VERSION) {
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  /** Add a column only if it isn't already present (safe across partial migrations). */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const present = this.db
      .prepare<
        [string, string],
        { n: number }
      >('SELECT 1 AS n FROM pragma_table_info(?) WHERE name = ?')
      .get(table, column);
    if (!present) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  create(input: CreateLearningInput): Learning {
    // Dedup gate: re-distilling the same session (the modal's similar-merge is only
    // advisory) shouldn't pile up identical entries. If an entry with the same
    // title already exists for this source session, return it instead of inserting.
    if (input.sourceSessionId) {
      const dup = this.db
        .prepare('SELECT * FROM learnings WHERE source_session_id = ? AND title = ? LIMIT 1')
        .get(input.sourceSessionId, input.title) as Record<string, unknown> | undefined;
      if (dup) return this.rowToLearning(dup);
    }
    const ts = this.now();
    const row: Learning = {
      id: randomUUID(),
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      sourceAgent: input.sourceAgent ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceCwd: input.sourceCwd ?? null,
      sourceProject: input.sourceProject ?? null,
      model: input.model ?? null,
      createdAt: ts,
      updatedAt: ts
    };
    this.db
      .prepare(
        `INSERT INTO learnings
          (id, title, body, tags, source_agent, source_session_id, source_cwd,
           source_project, model, created_at, updated_at)
         VALUES
          (@id, @title, @body, @tags, @sourceAgent, @sourceSessionId, @sourceCwd,
           @sourceProject, @model, @createdAt, @updatedAt)`
      )
      .run({
        ...row,
        tags: JSON.stringify(row.tags)
      });
    return row;
  }

  update(id: string, fields: UpdateLearningInput): Learning | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: Learning = {
      ...existing,
      title: fields.title ?? existing.title,
      body: fields.body ?? existing.body,
      tags: fields.tags ?? existing.tags,
      updatedAt: this.now()
    };
    // The embedding is built from title + body; reset its freshness so the backfill
    // pass re-embeds when either changed. A tag-only edit leaves the vector intact.
    const contentChanged = next.title !== existing.title || next.body !== existing.body;
    this.db
      .prepare(
        `UPDATE learnings
         SET title = @title, body = @body, tags = @tags, updated_at = @updatedAt
         ${contentChanged ? ', embedding_updated_at = NULL' : ''}
         WHERE id = @id`
      )
      .run({
        id,
        title: next.title,
        body: next.body,
        tags: JSON.stringify(next.tags),
        updatedAt: next.updatedAt
      });
    return next;
  }

  delete(id: string): void {
    // Drop the vector first (the join key is the learnings rowid, gone after delete).
    if (this.vec) {
      const row = this.db
        .prepare<[string], { rowid: number }>('SELECT rowid FROM learnings WHERE id = ?')
        .get(id);
      if (row) this.db.prepare('DELETE FROM learnings_vec WHERE rowid = ?').run(BigInt(row.rowid));
    }
    this.db.prepare('DELETE FROM learnings WHERE id = ?').run(id);
  }

  get(id: string): Learning | null {
    const r = this.db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToLearning(r) : null;
  }

  /** List or full-text search. With `filter.query` set, ranks by FTS relevance. */
  search(filter: LearningSearchFilter = {}): Learning[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.project) {
      where.push('l.source_project = @project');
      params.project = filter.project;
    }
    if (filter.tag) {
      // Exact membership in the JSON tags array. LIKE on the raw JSON string would
      // let `%`/`_` wildcards (e.g. tag = "%" → whole store) or an embedded quote
      // match unintended rows; json_each compares the decoded values exactly.
      where.push('EXISTS (SELECT 1 FROM json_each(l.tags) WHERE value = @tag)');
      params.tag = filter.tag;
    }

    // A query that yields no searchable tokens (empty or punctuation-only) falls
    // through to the plain listing below, same as an empty search box.
    const fts = filter.query ? toFtsQuery(filter.query) : '';
    if (fts) {
      where.push('learnings_fts MATCH @fts');
      params.fts = fts;
      const sql = `
        SELECT l.* FROM learnings l
        JOIN learnings_fts f ON f.rowid = l.rowid
        WHERE ${where.join(' AND ')}
        ORDER BY rank`;
      const rows = this.db.prepare(sql).all(params) as Array<Record<string, unknown>>;
      return rows.map((r) => this.rowToLearning(r));
    }

    const sql = `
      SELECT l.* FROM learnings l
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.created_at DESC`;
    const rows = this.db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToLearning(r));
  }

  /**
   * Find existing learnings that look like near-duplicates of `text` (typically a
   * draft's title + tags), ranked by FTS relevance. Unlike `search`, this ORs the
   * significant tokens so a partial overlap still surfaces a candidate.
   */
  findSimilar(text: string, limit = 3): Learning[] {
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
      .slice(0, 12);
    if (tokens.length === 0) return [];
    const fts = tokens.map((t) => `"${t}"*`).join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT l.* FROM learnings l
         JOIN learnings_fts f ON f.rowid = l.rowid
         WHERE learnings_fts MATCH @fts
         ORDER BY rank
         LIMIT @limit`
      )
      .all({ fts, limit }) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToLearning(r));
  }

  /** Distinct tags across the store with usage counts, most-used first. */
  allTags(): TagCount[] {
    // Aggregate in SQL via json_each rather than loading every row and JSON.parsing
    // tags in JS on the synchronous main thread.
    return this.db
      .prepare(
        `SELECT je.value AS tag, COUNT(*) AS count
         FROM learnings l, json_each(l.tags) je
         GROUP BY je.value
         ORDER BY count DESC, tag ASC`
      )
      .all() as TagCount[];
  }

  /** Learnings still needing an embedding (never embedded, or edited since). */
  pendingEmbeddings(limit: number): PendingEmbedding[] {
    if (!this.vec) return [];
    return this.db
      .prepare<[number], PendingEmbedding>(
        `SELECT rowid, id, title, body FROM learnings
         WHERE embedding_updated_at IS NULL
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit);
  }

  /**
   * Store (or replace) a learning's embedding and mark it fresh. `vec` length must
   * equal EMBED_DIM. No-op when vector search is unavailable.
   */
  setEmbedding(id: string, vec: Float32Array): void {
    if (!this.vec) return;
    const row = this.db
      .prepare<[string], { rowid: number }>('SELECT rowid FROM learnings WHERE id = ?')
      .get(id);
    if (!row) return;
    const rowid = BigInt(row.rowid);
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    const tx = this.db.transaction(() => {
      // vec0 rowids must be bound as BigInt — a JS number binds as REAL and is
      // rejected ("Only integers are allows for primary key").
      this.db
        .prepare('INSERT OR REPLACE INTO learnings_vec(rowid, embedding) VALUES (?, ?)')
        .run(rowid, blob);
      this.db
        .prepare('UPDATE learnings SET embedding_updated_at = ? WHERE id = ?')
        .run(this.now(), id);
    });
    tx();
  }

  /** K-nearest learnings to a query vector, nearest first. Empty when unavailable. */
  vectorSearch(queryVec: Float32Array, limit: number): VecHit[] {
    if (!this.vec) return [];
    const blob = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
    return this.db
      .prepare<[Buffer, number], VecHit>(
        `SELECT l.id AS id, v.distance AS distance
         FROM learnings_vec v
         JOIN learnings l ON l.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`
      )
      .all(blob, limit);
  }

  schemaVersion(): number {
    return Number(this.db.pragma('user_version', { simple: true }));
  }

  close(): void {
    this.db.close();
  }

  private rowToLearning(r: Record<string, unknown>): Learning {
    return {
      id: r.id as string,
      title: r.title as string,
      body: r.body as string,
      tags: JSON.parse((r.tags as string) || '[]') as string[],
      sourceAgent: (r.source_agent as SessionAgent | null) ?? null,
      sourceSessionId: (r.source_session_id as string | null) ?? null,
      sourceCwd: (r.source_cwd as string | null) ?? null,
      sourceProject: (r.source_project as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number
    };
  }
}
