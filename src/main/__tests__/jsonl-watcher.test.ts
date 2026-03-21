import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { JsonlRecord } from '../jsonl-watcher';

type EmittedRecord = {
  sessionId: string;
  record: JsonlRecord;
};

type WatchEvent = 'add' | 'change' | 'unlink' | 'ready';
type WatchHandler = (...args: string[]) => void;

class FakeFsWatcher {
  private handlers = new Map<WatchEvent, WatchHandler[]>();
  close = vi.fn(async () => {});

  on(event: WatchEvent, handler: WatchHandler): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  async emit(event: WatchEvent, ...args: string[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
    await sleep(0);
  }
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-jsonl-test-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for assertion');
}

describe('JsonlWatcher', () => {
  let JsonlWatcher: typeof import('../jsonl-watcher').JsonlWatcher;
  let dir: string;
  let projectDir: string;
  let emitted: EmittedRecord[];
  let fakeWatcher: FakeFsWatcher;
  let watchSpy: ReturnType<typeof vi.fn>;
  let watcher: import('../jsonl-watcher').JsonlWatcher;

  beforeEach(async () => {
    vi.resetModules();
    dir = createTempDir();
    projectDir = join(dir, 'project-abc');
    mkdirSync(projectDir, { recursive: true });
    emitted = [];
    fakeWatcher = new FakeFsWatcher();
    watchSpy = vi.fn(() => fakeWatcher);

    vi.doMock('chokidar', () => ({
      default: { watch: watchSpy },
      watch: watchSpy
    }));
    ({ JsonlWatcher } = await import('../jsonl-watcher'));
  });

  afterEach(async () => {
    watcher?.stop();
    await sleep(0);
    rmSync(dir, { recursive: true, force: true });
    vi.doUnmock('chokidar');
  });

  function startWatcher(): void {
    watcher = new JsonlWatcher(dir);
    watcher.onRecord((sessionId, record) => {
      emitted.push({ sessionId, record });
    });
    watcher.start();
  }

  it('skips pre-existing files on startup', async () => {
    const filePath = join(projectDir, 'session-existing.jsonl');
    writeFileSync(filePath, `${JSON.stringify({ type: 'user' })}\n`);

    startWatcher();
    await fakeWatcher.emit('add', filePath);
    await fakeWatcher.emit('ready');
    await sleep(50);

    expect(emitted).toEqual([]);
  });

  it('reads a new file from byte 0 after ready', async () => {
    startWatcher();
    await fakeWatcher.emit('ready');

    const filePath = join(projectDir, 'session-live.jsonl');
    writeFileSync(filePath, `${JSON.stringify({ type: 'assistant' })}\n`);
    await fakeWatcher.emit('add', filePath);

    await waitFor(() => {
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        sessionId: 'session-live',
        record: { type: 'assistant' }
      });
    });
  });

  it('emits only appended records for an existing file', async () => {
    const filePath = join(projectDir, 'session-append.jsonl');
    writeFileSync(filePath, `${JSON.stringify({ type: 'user' })}\n`);

    startWatcher();
    await fakeWatcher.emit('add', filePath);
    await fakeWatcher.emit('ready');

    appendFileSync(filePath, `${JSON.stringify({ type: 'assistant' })}\n`);
    await fakeWatcher.emit('change', filePath);

    await waitFor(() => {
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        sessionId: 'session-append',
        record: { type: 'assistant' }
      });
    });
  });

  it('resets offset after truncation', async () => {
    const filePath = join(projectDir, 'session-truncate.jsonl');
    const firstRecord = { type: 'assistant', message: 'this record is intentionally longer' };
    const secondRecord = { type: 'user' };

    startWatcher();
    await fakeWatcher.emit('ready');

    writeFileSync(filePath, `${JSON.stringify(firstRecord)}\n`);
    await fakeWatcher.emit('add', filePath);

    await waitFor(() => {
      expect(emitted).toHaveLength(1);
    });

    writeFileSync(filePath, `${JSON.stringify(secondRecord)}\n`);
    await fakeWatcher.emit('change', filePath);

    await waitFor(() => {
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toMatchObject({
        sessionId: 'session-truncate',
        record: secondRecord
      });
    });
  });

  it('supports unlink and recreate for the same path', async () => {
    const filePath = join(projectDir, 'session-recreate.jsonl');

    startWatcher();
    await fakeWatcher.emit('ready');

    writeFileSync(filePath, `${JSON.stringify({ type: 'user' })}\n`);
    await fakeWatcher.emit('add', filePath);

    await waitFor(() => {
      expect(emitted).toHaveLength(1);
    });

    unlinkSync(filePath);
    await fakeWatcher.emit('unlink', filePath);

    writeFileSync(filePath, `${JSON.stringify({ type: 'assistant' })}\n`);
    await fakeWatcher.emit('add', filePath);

    await waitFor(() => {
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toMatchObject({
        sessionId: 'session-recreate',
        record: { type: 'assistant' }
      });
    });
  });

  it('does not duplicate records across rapid successive changes', async () => {
    const filePath = join(projectDir, 'session-rapid.jsonl');

    startWatcher();
    await fakeWatcher.emit('ready');

    writeFileSync(filePath, '');
    await fakeWatcher.emit('add', filePath);

    appendFileSync(filePath, `${JSON.stringify({ type: 'user', seq: 1 })}\n`);
    const firstChange = fakeWatcher.emit('change', filePath);
    appendFileSync(filePath, `${JSON.stringify({ type: 'assistant', seq: 2 })}\n`);
    const secondChange = fakeWatcher.emit('change', filePath);
    await Promise.all([firstChange, secondChange]);

    await waitFor(() => {
      expect(emitted).toHaveLength(2);
    });

    expect(emitted.map(({ record }) => record.seq)).toEqual([1, 2]);
  });

  it('buffers partial lines until a newline arrives', async () => {
    const filePath = join(projectDir, 'session-partial.jsonl');

    startWatcher();
    await fakeWatcher.emit('ready');

    writeFileSync(filePath, '{"type":"assistant"');
    await fakeWatcher.emit('add', filePath);
    await sleep(50);

    expect(emitted).toEqual([]);

    appendFileSync(filePath, ',"step":1}\n');
    await fakeWatcher.emit('change', filePath);

    await waitFor(() => {
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        sessionId: 'session-partial',
        record: { type: 'assistant', step: 1 }
      });
    });
  });

  it('does not create a recurring scan timer in production mode', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    try {
      const mocked = new JsonlWatcher(dir);
      mocked.start();

      expect(watchSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect('scanTimer' in (mocked as object)).toBe(false);

      mocked.stop();
      expect(fakeWatcher.close).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
