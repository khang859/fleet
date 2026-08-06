import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHistoryStore } from '../history-store';
import { HISTORY_LIMIT } from '../../../shared/agent-history';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agent-history-'));
  file = join(dir, 'history.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Lines as they sit on disk, which is what a second store would read. */
function lines(): unknown[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

describe('AgentHistoryStore', () => {
  it('offers nothing when the file does not exist', () => {
    expect(new AgentHistoryStore(join(dir, 'nothing-here.jsonl')).list('/repo')).toEqual([]);
  });

  it('makes the folder it writes into', () => {
    const nested = new AgentHistoryStore(join(dir, 'a', 'b', 'history.jsonl'));
    nested.add('/repo', 'hello');
    expect(nested.list('/repo')).toEqual(['hello']);
  });

  it('recalls newest first', () => {
    const store = new AgentHistoryStore(file);
    store.add('/repo', 'first');
    store.add('/repo', 'second');
    expect(store.list('/repo')).toEqual(['second', 'first']);
  });

  it('survives being reopened', () => {
    new AgentHistoryStore(file).add('/repo', 'written by one');
    expect(new AgentHistoryStore(file).list('/repo')).toEqual(['written by one']);
  });

  it('keeps folders apart', () => {
    const store = new AgentHistoryStore(file);
    store.add('/repo', 'mine');
    store.add('/other', 'theirs');
    expect(store.list('/repo')).toEqual(['mine']);
    expect(store.list('/other')).toEqual(['theirs']);
  });

  it('writes one entry for the same prompt sent twice in a row', () => {
    const store = new AgentHistoryStore(file);
    store.add('/repo', 'run the tests');
    store.add('/repo', 'run the tests');
    expect(lines()).toHaveLength(1);
  });

  it('writes both when the repeat is in a different folder', () => {
    const store = new AgentHistoryStore(file);
    store.add('/repo', 'run the tests');
    store.add('/other', 'run the tests');
    expect(lines()).toHaveLength(2);
  });

  it('trims the prompt it stores', () => {
    const store = new AgentHistoryStore(file);
    store.add('/repo', '  spaced out \n');
    expect(store.list('/repo')).toEqual(['spaced out']);
  });

  it('ignores an empty prompt', () => {
    const store = new AgentHistoryStore(file);
    store.add('/repo', '   \n  ');
    expect(store.list('/repo')).toEqual([]);
  });

  it('keeps a multi-line prompt whole', () => {
    const store = new AgentHistoryStore(file);
    const prompt = 'first line\nsecond line\n\nfourth';
    store.add('/repo', prompt);
    expect(new AgentHistoryStore(file).list('/repo')).toEqual([prompt]);
    // One JSON object per line, whatever is inside it.
    expect(lines()).toHaveLength(1);
  });

  it('skips a line that will not parse instead of losing the file', () => {
    const store = new AgentHistoryStore(file);
    store.add('/repo', 'before');
    appendFileSync(file, 'this is not json\n', 'utf8');
    store.add('/repo', 'after');
    expect(new AgentHistoryStore(file).list('/repo')).toEqual(['after', 'before']);
  });

  it('skips a line that parses but is the wrong shape', () => {
    writeFileSync(file, `${JSON.stringify({ text: 'no folder', at: 1 })}\n`, 'utf8');
    expect(new AgentHistoryStore(file).list('/repo')).toEqual([]);
  });

  it('reads a file it did not write', () => {
    writeFileSync(
      file,
      `${JSON.stringify({ text: 'old', cwd: '/repo', at: 1 })}\n${JSON.stringify({ text: 'new', cwd: '/repo', at: 2 })}\n`,
      'utf8'
    );
    expect(new AgentHistoryStore(file).list('/repo')).toEqual(['new', 'old']);
  });

  describe('compaction', () => {
    /** Enough entries to cross the threshold, spread over two folders. */
    function fill(store: AgentHistoryStore, count: number): void {
      for (let i = 0; i < count; i += 1) store.add(i % 2 === 0 ? '/repo' : '/other', `prompt ${i}`);
    }

    it('keeps the newest of each folder and drops the rest', () => {
      const store = new AgentHistoryStore(file);
      fill(store, 2000);
      // Both folders survive, each cut to its own budget rather than the busier
      // one pushing the quieter one out.
      expect(store.list('/repo')).toHaveLength(HISTORY_LIMIT);
      expect(store.list('/other')).toHaveLength(HISTORY_LIMIT);
      expect(store.list('/repo')[0]).toBe('prompt 1998');
      expect(store.list('/other')[0]).toBe('prompt 1999');
    });

    it('leaves the file matching what it just said', () => {
      const store = new AgentHistoryStore(file);
      fill(store, 2000);
      expect(lines()).toHaveLength(HISTORY_LIMIT * 2);
      expect(new AgentHistoryStore(file).list('/repo')).toEqual(store.list('/repo'));
    });

    it('leaves no temporary file behind', () => {
      const store = new AgentHistoryStore(file);
      fill(store, 2000);
      const stray = readFileSync(file, 'utf8');
      expect(stray.length).toBeGreaterThan(0);
      expect(() => readFileSync(`${file}.${process.pid}.tmp`, 'utf8')).toThrow();
    });

    it('carries on appending afterwards', () => {
      const store = new AgentHistoryStore(file);
      fill(store, 2000);
      store.add('/repo', 'after the compaction');
      expect(store.list('/repo')[0]).toBe('after the compaction');
      expect(new AgentHistoryStore(file).list('/repo')[0]).toBe('after the compaction');
    });
  });
});
