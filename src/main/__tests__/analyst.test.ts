// src/main/__tests__/analyst.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type * as ChildProcess from 'child_process';
// Mock child_process.spawn before importing Analyst
let mockProc: unknown = null;
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(() => mockProc) };
});

import { spawn } from 'child_process';
import { Analyst } from '../starbase/analyst';
import type { ShipsLog } from '../starbase/ships-log';

/** Build a fake process that never closes (used to trigger timeout). */
function makeMockProcThatNeverCloses() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  return proc;
}

/** Build a fake EventEmitter-based process that emits stdout data then closes. */
function makeMockProc(stdoutData: string, exitCode = 0) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  // Emit data asynchronously so the promise chain is set up first
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from(stdoutData));
    proc.emit('close', exitCode);
  });
  return proc;
}

/** Minimal fake DB with a prepare().run() stub */
function makeDb() {
  const rows: unknown[] = [];
  return {
    prepare: vi.fn().mockReturnValue({ run: vi.fn((...args: unknown[]) => rows.push(args)) }),
    _rows: rows
  } as unknown as { prepare: ReturnType<typeof vi.fn>; _rows: unknown[] };
}

function makeShipsLog() {
  const logSpy = vi.fn().mockReturnValue(1);
  return { log: logSpy } as unknown as ShipsLog & { log: ReturnType<typeof vi.fn> };
}

describe('Analyst', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    mockProc = null;
    vi.mocked(spawn).mockClear();
  });

  describe('classifyError', () => {
    it('returns classification from valid LLM JSON', async () => {
      mockProc = makeMockProc('{"classification": "transient", "reason": "network blip"}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.classifyError('Error: connection reset');
      expect(result).toBe('transient');
    });

    it('returns non-retryable from valid LLM JSON', async () => {
      mockProc = makeMockProc('{"classification": "non-retryable", "reason": "missing file"}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.classifyError('ENOENT: no such file or directory');
      expect(result).toBe('non-retryable');
    });

    it('parses JSON inside a code fence', async () => {
      mockProc = makeMockProc(
        'Sure!\n```json\n{"classification": "persistent", "reason": "same error"}\n```'
      );
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.classifyError('the same error again');
      expect(result).toBe('persistent');
    });

    it('returns null and writes degraded comms on non-zero exit', async () => {
      mockProc = makeMockProc('', 1);
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.classifyError('some error');
      expect(result).toBeNull();
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('analyst_degraded'));
    });

    it('returns null on malformed JSON', async () => {
      mockProc = makeMockProc('not json at all');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.classifyError('some error');
      expect(result).toBeNull();
    });

    it('returns null on unknown classification value', async () => {
      mockProc = makeMockProc('{"classification": "unknown-thing", "reason": "x"}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.classifyError('some error');
      expect(result).toBeNull();
    });

    it('logs analyst_classified to ships log on success', async () => {
      mockProc = makeMockProc('{"classification": "transient", "reason": "blip"}');
      const shipsLog = makeShipsLog();
      const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
      await analyst.classifyError('Error: connection reset');
      expect(shipsLog.log).toHaveBeenCalledWith({
        eventType: 'analyst_classified',
        detail: { classification: 'transient', method: 'classifyError' }
      });
    });

    it('logs analyst_degraded to ships log on failure', async () => {
      mockProc = makeMockProc('', 1);
      const shipsLog = makeShipsLog();
      const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
      await analyst.classifyError('some error');
      expect(shipsLog.log).toHaveBeenCalledWith({
        eventType: 'analyst_degraded',
        detail: expect.objectContaining({ method: 'classifyError' })
      });
    });

    it('rate-limits analyst_degraded comms to once per 5 minutes per method', async () => {
      mockProc = makeMockProc('', 1);
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      await analyst.classifyError('err1');

      // Immediately fail again — should NOT write a second comms
      mockProc = makeMockProc('', 1);
      await analyst.classifyError('err2');

      const insertCalls = db.prepare.mock.calls.filter((args: unknown[]) =>
        String(args[0]).includes('analyst_degraded')
      );
      expect(insertCalls).toHaveLength(1);
    });
  });

  describe('summarizeCILogs', () => {
    it('returns the summary string from valid LLM JSON', async () => {
      mockProc = makeMockProc('{"summary": "Build failed: missing dependency foo"}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.summarizeCILogs('...raw CI logs...');
      expect(result).toBe('Build failed: missing dependency foo');
    });

    it('logs analyst_summarized to ships log on success', async () => {
      mockProc = makeMockProc('{"summary": "Build failed"}');
      const shipsLog = makeShipsLog();
      const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
      await analyst.summarizeCILogs('raw logs');
      expect(shipsLog.log).toHaveBeenCalledWith({
        eventType: 'analyst_summarized',
        detail: { method: 'summarizeCILogs' }
      });
    });

    it('returns null on missing summary field', async () => {
      mockProc = makeMockProc('{"wrong": "field"}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.summarizeCILogs('logs');
      expect(result).toBeNull();
    });
  });

  describe('extractPRVerdict', () => {
    it('returns APPROVE verdict', async () => {
      mockProc = makeMockProc('{"verdict": "APPROVE", "notes": "Looks good"}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.extractPRVerdict('LGTM, great work');
      expect(result).toEqual({ verdict: 'APPROVE', notes: 'Looks good' });
    });

    it('returns REQUEST_CHANGES verdict', async () => {
      mockProc = makeMockProc('{"verdict": "REQUEST_CHANGES", "notes": "Missing tests"}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.extractPRVerdict('Missing test coverage');
      expect(result).toEqual({ verdict: 'REQUEST_CHANGES', notes: 'Missing tests' });
    });

    it('logs analyst_verdict_extracted to ships log on success', async () => {
      mockProc = makeMockProc('{"verdict": "APPROVE", "notes": "LGTM"}');
      const shipsLog = makeShipsLog();
      const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
      await analyst.extractPRVerdict('output');
      expect(shipsLog.log).toHaveBeenCalledWith({
        eventType: 'analyst_verdict_extracted',
        detail: { verdict: 'APPROVE', method: 'extractPRVerdict' }
      });
    });

    it('returns null for invalid verdict value', async () => {
      mockProc = makeMockProc('{"verdict": "MAYBE", "notes": "not sure"}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.extractPRVerdict('some output');
      expect(result).toBeNull();
    });
  });

  describe('writeHailingContext', () => {
    it('returns context string from valid LLM JSON', async () => {
      mockProc = makeMockProc('{"context": "The crew appears stuck waiting for user input."}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.writeHailingContext('Should I push to main?');
      expect(result).toBe('The crew appears stuck waiting for user input.');
    });

    it('logs analyst_hailing_context to ships log on success', async () => {
      mockProc = makeMockProc('{"context": "The crew is stuck."}');
      const shipsLog = makeShipsLog();
      const analyst = new Analyst({ db: db as any, timeoutMs: 100, shipsLog });
      await analyst.writeHailingContext('question');
      expect(shipsLog.log).toHaveBeenCalledWith({
        eventType: 'analyst_hailing_context',
        detail: { method: 'writeHailingContext' }
      });
    });

    it('returns null on invalid schema', async () => {
      mockProc = makeMockProc('{"wrong": "field"}');
      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.writeHailingContext('question');
      expect(result).toBeNull();
    });
  });

  describe('timeout and retry', () => {
    it('retries once on timeout and returns result from second attempt', async () => {
      // Create the success proc lazily so setImmediate is scheduled after the retry spawns it,
      // not eagerly before the first timeout fires.
      let callCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return makeMockProcThatNeverCloses() as any;
        return makeMockProc('{"classification": "transient", "reason": "blip"}') as any;
      });

      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.classifyError('some error');
      expect(result).toBe('transient');
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    });

    it('triggers degraded fallback on double timeout', async () => {
      vi.mocked(spawn).mockImplementation(() => makeMockProcThatNeverCloses() as any);

      const analyst = new Analyst({ db: db as any, timeoutMs: 100 });
      const result = await analyst.classifyError('some error');
      expect(result).toBeNull();
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('analyst_degraded'));
      expect(vi.mocked(spawn).mock.calls).toHaveLength(2);
    });
  });
});
