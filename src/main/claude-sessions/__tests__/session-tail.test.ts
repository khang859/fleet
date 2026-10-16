import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonlTail, SessionTail } from '../session-tail';

let dir = '';
let path = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-session-tail-'));
  path = join(dir, 'sess.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function linesRead(tail: JsonlTail): Promise<string[]> {
  const lines: string[] = [];
  await tail.read(path, (line) => lines.push(line));
  return lines;
}

describe('JsonlTail', () => {
  it('hands over each line once', async () => {
    const tail = new JsonlTail();
    writeFileSync(path, '{"a":1}\n{"a":2}\n');
    expect(await linesRead(tail)).toEqual(['{"a":1}', '{"a":2}']);
    appendFileSync(path, '{"a":3}\n');
    expect(await linesRead(tail)).toEqual(['{"a":3}']);
    expect(await linesRead(tail)).toEqual([]);
  });

  it('holds a line still being written until the rest arrives', async () => {
    const tail = new JsonlTail();
    writeFileSync(path, '{"a":1}\n{"a":');
    expect(await linesRead(tail)).toEqual(['{"a":1}']);
    appendFileSync(path, '2}\n');
    expect(await linesRead(tail)).toEqual(['{"a":2}']);
  });

  it('keeps a character whole when it is split across appends', async () => {
    const tail = new JsonlTail();
    const bytes = Buffer.from('{"t":"héllo"}\n');
    const cut = bytes.indexOf(0xa9); // inside the two bytes of "é"
    writeFileSync(path, bytes.subarray(0, cut));
    expect(await linesRead(tail)).toEqual([]);
    appendFileSync(path, bytes.subarray(cut));
    expect(await linesRead(tail)).toEqual(['{"t":"héllo"}']);
  });

  it('reports a file that got shorter', async () => {
    const tail = new JsonlTail();
    writeFileSync(path, '{"a":1}\n{"a":2}\n');
    await linesRead(tail);
    writeFileSync(path, '{"b":1}\n');
    expect(await tail.read(path, () => undefined)).toBe(false);
  });

  it('treats a file not written yet as empty', async () => {
    expect(await new JsonlTail().read(join(dir, 'none.jsonl'), () => undefined)).toBe(true);
  });
});

describe('SessionTail', () => {
  it('reads the transcript, then subagent transcripts as they appear', async () => {
    const tail = new SessionTail(path);
    const seen: Array<[string, boolean]> = [];
    const read = async (): Promise<void> =>
      tail.read(
        (line, sub) => seen.push([line, sub]),
        () => undefined
      );
    writeFileSync(path, '{"main":1}\n');
    await read();
    const subagents = join(dir, 'sess', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-a.jsonl'), '{"sub":1}\n');
    writeFileSync(join(subagents, 'agent-a.meta.json'), '{}');
    appendFileSync(path, '{"main":2}\n');
    await read();
    expect(seen).toEqual([
      ['{"main":1}', false],
      ['{"main":2}', false],
      ['{"sub":1}', true]
    ]);
  });

  it('reads every file again after one got shorter', async () => {
    const tail = new SessionTail(path);
    const seen: string[] = [];
    const onReset = vi.fn(() => (seen.length = 0));
    const read = async (): Promise<void> => tail.read((line) => seen.push(line), onReset);
    writeFileSync(path, '{"main":1}\n{"main":2}\n');
    await read();
    writeFileSync(path, '{"new":1}\n');
    await read();
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['{"new":1}']);
  });
});
