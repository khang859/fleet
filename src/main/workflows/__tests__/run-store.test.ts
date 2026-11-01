import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardItem } from '../../../shared/workflows';
import { RunStore } from '../run-store';
import { makeRun } from './helpers';

const RUN = 'run-1';

function item(id: number, fields: Partial<BoardItem> = {}): BoardItem {
  return { id: String(id), agent: 'A', kind: 'bug', text: `item ${id}`, ...fields };
}

describe('RunStore', () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-store-'));
    store = new RunStore(dir);
    store.create(RUN, 'name = "Review"');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const logPath = (): string => join(dir, RUN, 'board.log');

  it('keeps the approved bytes of a workflow', () => {
    expect(store.workflowBytes(RUN)).toBe('name = "Review"');
  });

  it('writes a prompt and answers its path', () => {
    const path = store.writePrompt(RUN, 'a.md', 'brief');

    expect(path).toBe(join(dir, RUN, 'prompts', 'a.md'));
    expect(existsSync(path)).toBe(true);
  });

  it('reloads the board in a new store', () => {
    store.appendBoard(RUN, item(1));
    store.appendBoard(RUN, item(2));

    expect(new RunStore(dir).loadBoard(RUN)).toEqual([item(1), item(2)]);
  });

  it('lets a later change of an item win', () => {
    store.appendBoard(RUN, item(1));
    store.appendBoard(RUN, item(1, { mergedInto: '2' }));

    expect(store.loadBoard(RUN)).toEqual([item(1, { mergedInto: '2' })]);
  });

  it('ignores half a line at the end of the log', () => {
    store.appendBoard(RUN, item(1));
    appendFileSync(logPath(), '{"seq":2,"item":{"id":"2","ag');

    expect(new RunStore(dir).loadBoard(RUN)).toEqual([item(1)]);
  });

  it('keeps an item added after half a line', () => {
    store.appendBoard(RUN, item(1));
    appendFileSync(logPath(), '{"seq":2,"item":{"id":"2","ag');

    const next = new RunStore(dir);
    next.appendBoard(RUN, item(3));

    expect(new RunStore(dir).loadBoard(RUN)).toEqual([item(1), item(3)]);
  });

  it('keeps every item across a snapshot', () => {
    for (let id = 1; id <= 53; id++) store.appendBoard(RUN, item(id));

    expect(existsSync(join(dir, RUN, 'board.json'))).toBe(true);

    const board = new RunStore(dir).loadBoard(RUN);

    expect(board).toHaveLength(53);
    expect(board.map((entry) => entry.id)).toEqual(
      Array.from({ length: 53 }, (_, index) => String(index + 1))
    );
  });

  it('goes on counting in a new store after a snapshot', () => {
    for (let id = 1; id <= 50; id++) store.appendBoard(RUN, item(id));

    const next = new RunStore(dir);
    next.appendBoard(RUN, item(51));
    next.appendBoard(RUN, item(1, { mergedInto: '51' }));

    const board = new RunStore(dir).loadBoard(RUN);

    expect(board).toHaveLength(51);
    expect(board[0].mergedInto).toBe('51');
  });

  it('saves a run with no board in its record', () => {
    store.save(makeRun({ id: RUN, board: [item(9)] }));
    store.appendBoard(RUN, item(1));

    const [run] = new RunStore(dir).loadAll();

    expect(run.id).toBe(RUN);
    expect(run.board).toEqual([item(1)]);
  });

  it('skips a broken record and sorts by age', () => {
    store.save(makeRun({ id: RUN, createdAt: 20 }));
    store.create('run-2', 'x');
    store.save(makeRun({ id: 'run-2', createdAt: 10 }));
    store.create('run-3', 'x');
    writeFileSync(join(dir, 'run-3', 'run.json'), '{ broken');
    mkdirSync(join(dir, 'empty-folder'));

    expect(store.loadAll().map((run) => run.id)).toEqual(['run-2', RUN]);
  });
});
