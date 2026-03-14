import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JsonlWatcher, JsonlRecord } from '../jsonl-watcher';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function tmpDir(): string {
  const dir = join(tmpdir(), `fleet-jsonl-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('JsonlWatcher', () => {
  let dir: string;
  let watcher: JsonlWatcher;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a JSONL record with tool_use', async () => {
    const callback = vi.fn();
    watcher = new JsonlWatcher(dir);
    watcher.onRecord(callback);
    watcher.start();

    const filePath = join(dir, 'session-1.jsonl');
    const record = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Edit', input: {} }],
      },
    };
    writeFileSync(filePath, JSON.stringify(record) + '\n');

    await new Promise((r) => setTimeout(r, 500));

    expect(callback).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'assistant' }),
    );
  });

  it('handles multiple records appended to the same file', async () => {
    const callback = vi.fn();
    watcher = new JsonlWatcher(dir);
    watcher.onRecord(callback);
    watcher.start();

    const filePath = join(dir, 'session-2.jsonl');
    writeFileSync(filePath, JSON.stringify({ type: 'user' }) + '\n');

    await new Promise((r) => setTimeout(r, 500));

    appendFileSync(filePath, JSON.stringify({ type: 'assistant' }) + '\n');

    await new Promise((r) => setTimeout(r, 500));

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('ignores non-JSONL files', async () => {
    const callback = vi.fn();
    watcher = new JsonlWatcher(dir);
    watcher.onRecord(callback);
    watcher.start();

    writeFileSync(join(dir, 'readme.txt'), 'hello\n');

    await new Promise((r) => setTimeout(r, 500));

    expect(callback).not.toHaveBeenCalled();
  });
});
