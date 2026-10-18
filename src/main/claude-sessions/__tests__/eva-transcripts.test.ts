import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaDatabases, evaRecordEvents, EvaTranscripts } from '../eva-transcripts';

const TABLES = readFileSync(join(__dirname, 'fixtures', 'eva-0.3.0-tables.sql'), 'utf8');
const VIEWS = readFileSync(join(__dirname, 'fixtures', 'eva-0.3.0-views.sql'), 'utf8');
const SESSION = '5f0c2a8e-1b9d-4c3e-9a7f-2d6b8e4c1a30';

type Row = {
  kind: string;
  content?: string;
  calls?: unknown[];
  call_id?: string;
  status?: string;
  agent?: string;
  parent_call?: string;
};

describe('EvaTranscripts', () => {
  let dir: string;
  let dbPath: string;
  let eva: Database.Database | undefined;
  let transcripts: EvaTranscripts;

  /** Save records as eva does, one row each. */
  function save(...rows: Row[]): void {
    const insert = eva!.prepare(
      `INSERT INTO records (session_id, kind, content, calls, call_id, status, agent, parent_call, created_at)
       VALUES (1, @kind, @content, @calls, @call_id, @status, @agent, @parent_call, @created_at)`
    );
    for (const r of rows) {
      insert.run({
        kind: r.kind,
        content: r.content ?? '',
        calls: r.calls ? JSON.stringify(r.calls) : null,
        call_id: r.call_id ?? null,
        status: r.status ?? null,
        agent: r.agent ?? null,
        parent_call: r.parent_call ?? null,
        created_at: Date.UTC(2026, 9, 18, 9, 30)
      });
    }
  }

  const call = (id: string, name: string, args: unknown): Record<string, string> => ({
    id,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args)
  });

  function makeEva(schema: string): void {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(schema);
    db.prepare(
      `INSERT INTO sessions (id, created_at, updated_at, model, title, uuid) VALUES (1, 0, 0, 'm', 't', ?)`
    ).run(SESSION);
    eva = db;
  }

  beforeEach(() => {
    eva = undefined;
    dir = mkdtempSync(join(tmpdir(), 'eva-transcripts-'));
    dbPath = join(dir, 'sessions.db');
    transcripts = new EvaTranscripts({ databases: () => [dbPath] });
  });

  afterEach(() => {
    transcripts.dispose();
    eva?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads turns and tool calls, named as Claude Code names them', async () => {
    makeEva(TABLES + VIEWS);
    save(
      { kind: 'question', content: 'List the files.' },
      { kind: 'answer', content: 'Looking.', calls: [call('c1', 'bash', { command: 'ls' })] },
      { kind: 'result', content: 'a.txt', call_id: 'c1', status: 'ok' },
      { kind: 'answer', calls: [call('c2', 'write_file', { path: 'b.txt', content: 'x' })] },
      { kind: 'result', content: 'no', call_id: 'c2', status: 'declined' },
      { kind: 'answer', content: 'There is a.txt.' },
      { kind: 'question', content: 'Thanks.' }
    );
    transcripts.follow(SESSION, dbPath);
    const t = transcripts.read(SESSION)!;

    expect(t.unreadable).toBeUndefined();
    expect(t.index.turns.map((x) => [x.n, x.preview, x.start, x.end])).toEqual([
      [1, 'List the files.', 1, 7],
      [2, 'Thanks.', 7, null]
    ]);
    expect(t.index.turns[0].timestamp).toBe('2026-10-18T09:30:00.000Z');
    expect(t.end).toBe(8);
    expect(t.brief.state.goal?.value).toBe('List the files.');

    const first = await t.events({ start: 1, end: 7 });
    expect(first.map((e) => e.kind)).toEqual([
      'user_prompt',
      'assistant_text',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'assistant_text'
    ]);
    expect(first[2]).toMatchObject({ name: 'Bash', input: { command: 'ls' } });
    expect(first[4]).toMatchObject({
      name: 'Write',
      input: { path: 'b.txt', file_path: 'b.txt' }
    });
    expect(first[5]).toMatchObject({ toolUseId: 'c2', rejected: true, isError: false });

    const write = t.index.tool('c2')!;
    expect(write.name).toBe('Write');
    expect(await t.events(write.result!)).toMatchObject([{ kind: 'tool_result', text: 'no' }]);
  });

  it('reads only what was saved since the last read, without subagent records', async () => {
    makeEva(TABLES + VIEWS);
    save(
      { kind: 'question', content: 'Look around.' },
      { kind: 'answer', calls: [call('a1', 'agent', { prompt: 'Look.' })] },
      { kind: 'question', content: 'Look.', agent: 'explore', parent_call: 'a1' },
      { kind: 'answer', content: 'Seen.', agent: 'explore', parent_call: 'a1' }
    );
    transcripts.follow(SESSION, dbPath);
    expect(transcripts.read(SESSION)!.index.turns).toHaveLength(1);

    save(
      { kind: 'result', content: 'Seen.', call_id: 'a1', status: 'ok' },
      { kind: 'question', content: 'Now fix it.' }
    );
    const t = transcripts.read(SESSION)!;
    expect(t.index.turns.map((x) => x.preview)).toEqual(['Look around.', 'Now fix it.']);
    expect((await t.events({ start: 1, end: 6 })).map((e) => e.kind)).toEqual([
      'user_prompt',
      'tool_use',
      'tool_result'
    ]);
  });

  it('reads a summary as a compaction, which starts no turn', () => {
    makeEva(TABLES + VIEWS);
    save(
      { kind: 'question', content: 'Go.' },
      { kind: 'summary', content: 'We went.' },
      { kind: 'goal', content: 'the tests pass' }
    );
    transcripts.follow(SESSION, dbPath);
    expect(transcripts.read(SESSION)!.index.turns).toHaveLength(1);
  });

  it('says to update eva when it has no views, and Fleet when it has only newer ones', () => {
    makeEva(TABLES);
    transcripts.follow(SESSION, dbPath);
    expect(transcripts.read(SESSION)!.unreadable).toMatch(/Update eva to 0\.3\.0/);

    eva!.exec(`CREATE VIEW transcript_v2 AS SELECT 1 AS id`);
    expect(transcripts.read(SESSION)!.unreadable).toMatch(/transcript_v2.*Update Fleet/);
  });

  it('opens no database outside eva home', async () => {
    makeEva(TABLES + VIEWS);
    save({ kind: 'question', content: 'Go.' });
    transcripts = new EvaTranscripts({ databases: () => [join(dir, 'other.db')] });
    transcripts.follow(SESSION, dbPath);
    const t = transcripts.read(SESSION)!;
    expect(t.unreadable).toMatch(/outside eva's home/);
    expect(t.index.turns).toHaveLength(0);
    expect(await t.events({ start: 1, end: 2 })).toEqual([]);
  });

  it('says so when eva is not saving the session', () => {
    transcripts.follow(SESSION, undefined);
    expect(transcripts.read(SESSION)!.unreadable).toMatch(/not saving/);
  });

  it('reads a database eva made after the first hook event', () => {
    transcripts.follow(SESSION, dbPath);
    expect(transcripts.read(SESSION)!.unreadable).toMatch(/not made its database/);
    makeEva(TABLES + VIEWS);
    save({ kind: 'question', content: 'Go.' });
    transcripts.follow(SESSION, dbPath);
    expect(transcripts.read(SESSION)!.index.turns).toHaveLength(1);
  });

  it('says so when the database cannot be read', async () => {
    writeFileSync(dbPath, 'not a database, but long enough to be read as one '.repeat(10));
    transcripts.follow(SESSION, dbPath);
    const t = transcripts.read(SESSION)!;
    expect(t.unreadable).toMatch(/could not read eva's database/);
    expect(await t.events({ start: 1, end: 2 })).toEqual([]);
  });

  it('forgets a session', async () => {
    makeEva(TABLES + VIEWS);
    save({ kind: 'question', content: 'Go.' });
    transcripts.follow(SESSION, dbPath);
    const t = transcripts.read(SESSION)!;
    transcripts.forget(SESSION);
    expect(transcripts.read(SESSION)).toBeNull();
    expect(await t.events({ start: 1, end: 2 })).toEqual([]);
  });
});

describe('evaRecordEvents', () => {
  const record = { id: 3, created_at: null, content: '', calls: null, call_id: null, status: null };

  it('keeps arguments that are not JSON as text', () => {
    const calls = JSON.stringify([{ id: 'c', name: 'grep', arguments: 'not json' }]);
    expect(evaRecordEvents({ ...record, kind: 'answer', calls })).toEqual([
      {
        uuid: '3',
        timestamp: null,
        role: 'assistant',
        kind: 'tool_use',
        id: 'c',
        name: 'grep',
        input: { arguments: 'not json' }
      }
    ]);
  });

  it('reads a failed or stopped tool as an error, and other kinds as meta', () => {
    for (const status of ['error', 'stopped', 'not_run', 'interrupted']) {
      expect(evaRecordEvents({ ...record, kind: 'result', call_id: 'c', status })[0]).toMatchObject(
        { isError: true, rejected: false }
      );
    }
    expect(evaRecordEvents({ ...record, kind: 'verdict' })).toMatchObject([
      { kind: 'meta', subtype: 'verdict' }
    ]);
  });
});

describe('evaDatabases', () => {
  it('names the database under $EVA_HOME and under ~/.eva', () => {
    expect(evaDatabases({ EVA_HOME: '/e' }, '/h')).toEqual([
      '/e/sessions.db',
      '/h/.eva/sessions.db'
    ]);
    expect(evaDatabases({ EVA_HOME: '' }, '/h')).toEqual(['/h/.eva/sessions.db']);
  });
});
