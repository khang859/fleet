import Database from 'better-sqlite3';
import { realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { isRecord } from '../../shared/is-record';
import { createLogger } from '../logger';
import { BriefBuilder } from './brief';
import { evaToolInput, evaToolName } from './eva-tools';
import type { SessionTranscript } from './session-transcripts';
import { TranscriptIndex, type Span, type TranscriptEvent } from './transcript';

const log = createLogger('claude-sessions:eva');

/** The view of eva's records Fleet reads. eva adds a new name when it has to change one. */
const VIEW = 'transcript_v1';
/** How long a read waits for eva writing at the same time. */
const BUSY_TIMEOUT_MS = 2_000;
const COLUMNS = 'id, created_at, kind, content, calls, call_id, status';
const NOT_SAVING = 'eva is not saving this session, so its turns cannot be read.';
const NOT_MADE = 'eva has not made its database yet.';
const OUTSIDE = "eva named a database outside eva's home, so Fleet does not read it.";

/** The columns of eva's `transcript_v1` view Fleet reads. */
export type EvaRecord = {
  id: number;
  /** Milliseconds since the epoch; null on records eva saved before it kept the time. */
  created_at: number | null;
  kind: string;
  content: string;
  /** An answer's tool calls, as JSON `[{ id, name, arguments }]`; `arguments` is the model's JSON text. */
  calls: string | null;
  call_id: string | null;
  status: string | null;
};

/** The databases a hook may name: eva's own, under `$EVA_HOME` or `~/.eva`. */
export function evaDatabases(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const homes = [env['EVA_HOME'], join(home, '.eva')].filter((h): h is string => !!h);
  return homes.map((h) => join(h, 'sessions.db'));
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

type Call = { id: string; name: string; input: Record<string, unknown> };

function callsOf(json: string | null): Call[] {
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const calls: Call[] = [];
  for (const c of parsed) {
    if (!isRecord(c) || typeof c['id'] !== 'string' || typeof c['name'] !== 'string') continue;
    calls.push({ id: c['id'], name: c['name'], input: inputOf(c['arguments']) });
  }
  return calls;
}

/** A call's arguments: the model's JSON text, which may not be JSON at all. */
function inputOf(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return {};
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch {
    // kept as text below
  }
  return { arguments: text };
}

/** The transcript events one eva record stands for, named as Claude Code names them. */
export function evaRecordEvents(r: EvaRecord): TranscriptEvent[] {
  const info = {
    uuid: String(r.id),
    timestamp: r.created_at === null ? null : new Date(r.created_at).toISOString()
  };
  switch (r.kind) {
    case 'question':
      return [{ ...info, role: 'user', kind: 'user_prompt', text: r.content, source: 'human' }];
    case 'answer': {
      const events: TranscriptEvent[] = [];
      if (r.content) {
        events.push({ ...info, role: 'assistant', kind: 'assistant_text', text: r.content });
      }
      for (const call of callsOf(r.calls)) {
        events.push({
          ...info,
          role: 'assistant',
          kind: 'tool_use',
          id: call.id,
          name: evaToolName(call.name),
          input: evaToolInput(call.input)
        });
      }
      return events;
    }
    case 'result':
      return [
        {
          ...info,
          role: 'user',
          kind: 'tool_result',
          toolUseId: r.call_id ?? '',
          isError: r.status !== 'ok' && r.status !== 'declined',
          rejected: r.status === 'declined',
          text: r.content
        }
      ];
    // What replaced the conversation before it, as a compaction does.
    case 'summary':
    case 'checkpoint':
      return [{ ...info, role: 'user', kind: 'user_prompt', text: r.content, source: 'compact' }];
    // goal, verdict, goal_cleared, continuation, and kinds added later.
    default:
      return [{ ...info, role: null, kind: 'meta', subtype: r.kind }];
  }
}

type Followed = {
  /** The path the session's hook events last named. */
  named: string | undefined;
  /** The database to read; null when there is none Fleet may read. */
  dbPath: string | null;
  /** Why there is none, when there is none. */
  refused: string | null;
  /** The last record read. */
  cursor: number;
  index: TranscriptIndex;
  brief: BriefBuilder;
};

export type EvaTranscriptsOptions = {
  /** The databases eva sessions may be in. */
  databases?: () => string[];
};

/**
 * Reads what eva sessions said and did from eva's database, when a reader
 * asks. eva saves some records without a hook event, so each session keeps
 * its own cursor rather than trusting one. The database is opened read-only
 * and each read is one short statement, so eva's writes never wait on Fleet.
 */
export class EvaTranscripts {
  private readonly followed = new Map<string, Followed>();
  private readonly open = new Map<string, Database.Database>();
  private readonly databases: () => string[];

  constructor(opts: EvaTranscriptsOptions = {}) {
    this.databases = opts.databases ?? (() => evaDatabases());
  }

  /** An eva hook event arrived, naming the database its session is saved in, if any. */
  follow(sessionId: string, dbPath: string | undefined): void {
    const current = this.followed.get(sessionId);
    // A path refused while eva had not made the database yet is tried again.
    if (current && current.named === dbPath && (current.dbPath !== null || dbPath === undefined)) {
      return;
    }
    const refused = this.refusal(dbPath);
    if (refused === OUTSIDE)
      log.warn('ignored an eva database outside eva home', { sessionId, dbPath });
    this.followed.set(sessionId, {
      named: dbPath,
      dbPath: refused === null ? (dbPath ?? null) : null,
      refused,
      cursor: 0,
      index: new TranscriptIndex(),
      brief: new BriefBuilder()
    });
  }

  /** The session's transcript, read up to now. */
  read(sessionId: string): SessionTranscript | null {
    const f = this.followed.get(sessionId);
    if (!f) return null;
    const unreadable = this.catchUp(sessionId, f);
    return {
      index: f.index,
      end: f.cursor + 1,
      brief: f.brief,
      events: (span) => this.eventsIn(sessionId, f, span),
      ...(unreadable === null ? {} : { unreadable })
    };
  }

  forget(sessionId: string): void {
    this.followed.delete(sessionId);
  }

  dispose(): void {
    this.followed.clear();
    for (const db of this.open.values()) db.close();
    this.open.clear();
  }

  /**
   * Why Fleet does not read the database a hook event named; null when it does.
   * Any local process can send a hook event, so only eva's own is opened.
   */
  private refusal(dbPath: string | undefined): string | null {
    if (dbPath === undefined) return NOT_SAVING;
    const real = realOrNull(dbPath);
    if (real === null) return NOT_MADE;
    return this.databases().some((d) => realOrNull(d) === real) ? null : OUTSIDE;
  }

  /** Read the records saved since the last read; why it could not, when it could not. */
  private catchUp(sessionId: string, f: Followed): string | null {
    if (f.dbPath === null) return f.refused;
    try {
      const db = this.database(f.dbPath);
      const views = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'transcript_v%'"
        )
        .all()
        .map((v) => v.name);
      if (!views.includes(VIEW)) {
        return views.length === 0
          ? 'This eva is too old for Fleet to read its turns. Update eva to 0.3.0 or later.'
          : `This eva saves turns in a form Fleet does not read yet (${views.join(', ')}). Update Fleet.`;
      }
      const rows = db
        .prepare<
          [string, number],
          EvaRecord
        >(`SELECT ${COLUMNS} FROM ${VIEW} WHERE session_id = ? AND id > ? AND agent IS NULL ORDER BY id`)
        .all(sessionId, f.cursor);
      for (const r of rows) {
        const events = evaRecordEvents(r);
        f.index.add({ start: r.id, end: r.id + 1, events });
        for (const e of events) f.brief.apply(e);
        f.cursor = r.id;
      }
      return null;
    } catch (err) {
      this.close(f.dbPath);
      return `Fleet could not read eva's database: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private eventsIn(sessionId: string, f: Followed, span: Span): TranscriptEvent[] {
    if (f.dbPath === null || this.followed.get(sessionId) !== f) return [];
    try {
      const rows = this.database(f.dbPath)
        .prepare<
          [string, number, number],
          EvaRecord
        >(`SELECT ${COLUMNS} FROM ${VIEW} WHERE session_id = ? AND id >= ? AND id < ? AND agent IS NULL ORDER BY id`)
        .all(sessionId, span.start, span.end);
      return rows.flatMap(evaRecordEvents);
    } catch {
      this.close(f.dbPath);
      return [];
    }
  }

  private database(path: string): Database.Database {
    let db = this.open.get(path);
    if (!db) {
      db = new Database(path, { readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
      this.open.set(path, db);
    }
    return db;
  }

  /** Close a database that failed, so the next read opens it afresh. */
  private close(path: string): void {
    this.open.get(path)?.close();
    this.open.delete(path);
  }
}
