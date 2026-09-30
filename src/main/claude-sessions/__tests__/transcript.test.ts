import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeLine,
  readTranscriptRange,
  TranscriptTail,
  type TailLine,
  type TranscriptEvent
} from '../transcript';

const FIXTURE = join(__dirname, 'fixtures', 'turns.jsonl');
const fixture = readFileSync(FIXTURE);

/** Every event of a transcript, read whole. */
function allEvents(content: string): TranscriptEvent[] {
  return content.split('\n').flatMap(normalizeLine);
}

describe('normalizeLine', () => {
  it('matches the golden events for the fixture transcript', async () => {
    const events = allEvents(fixture.toString('utf8'));
    await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot(
      './fixtures/turns.events.json'
    );
  });

  it('tells human prompts, task notifications and compaction summaries apart', () => {
    const prompts = allEvents(fixture.toString('utf8')).filter((e) => e.kind === 'user_prompt');
    expect(prompts.map((e) => [e.uuid, e.source])).toEqual([
      ['u1', 'human'],
      ['u2', 'task'],
      ['u3', 'compact'],
      ['u4', 'human'],
      ['u5', 'human'],
      ['u7', 'human']
    ]);
  });

  it('marks a result the user rejected and an interrupt that cancelled a permission', () => {
    const events = allEvents(fixture.toString('utf8'));
    const rejected = events.find((e) => e.kind === 'tool_result' && e.toolUseId === 't4');
    expect(rejected).toMatchObject({ rejected: true, isError: true });
    const failed = events.find((e) => e.kind === 'tool_result' && e.toolUseId === 't3');
    expect(failed).toMatchObject({ rejected: false, isError: true });
    expect(
      events.filter((e) => e.kind === 'interrupted').map((e) => [e.uuid, e.role, e])
    ).toMatchObject([
      ['u6', 'user', { forToolUse: true }],
      ['a10', 'assistant', { forToolUse: false }]
    ]);
  });

  it('only treats a /clear prompt as a clear, not text that quotes one', () => {
    const quoted = JSON.stringify({
      type: 'user',
      uuid: 'r',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't',
            content: 'x <command-name>/clear</command-name>'
          }
        ]
      }
    });
    expect(normalizeLine(quoted).map((e) => e.kind)).toEqual(['tool_result']);
    const said = JSON.stringify({
      type: 'assistant',
      uuid: 'a',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '<command-name>/clear</command-name>' }]
      }
    });
    expect(normalizeLine(said).map((e) => e.kind)).toEqual(['assistant_text']);
  });

  it('skips blank, unfinished and unrelated lines', () => {
    expect(normalizeLine('')).toEqual([]);
    expect(normalizeLine('{"type":"user","uuid":"u","message":{"role":"us')).toEqual([]);
    expect(normalizeLine('{"type":"attachment","attachment":{}}')).toEqual([]);
    expect(normalizeLine('{"type":"user","message":{"role":"user","content":"no uuid"}}')).toEqual(
      []
    );
  });
});

describe('TranscriptTail', () => {
  function tailOf(chunks: Buffer[]): { tail: TranscriptTail; lines: TailLine[] } {
    const lines: TailLine[] = [];
    const tail = new TranscriptTail({ onLine: (l) => lines.push(l) });
    for (const chunk of chunks) tail.feed(chunk);
    return { tail, lines };
  }

  it('gives the same lines however the bytes are split', () => {
    const whole = tailOf([fixture]);
    // Split every 7 bytes, which cuts through multi-byte characters (— ✓ ✕).
    const pieces: Buffer[] = [];
    for (let i = 0; i < fixture.length; i += 7) pieces.push(fixture.subarray(i, i + 7));
    const split = tailOf(pieces);
    expect(split.lines).toEqual(whole.lines);
    expect(split.tail.turns).toEqual(whole.tail.turns);
    expect(whole.lines.flatMap((l) => l.events)).toEqual(allEvents(fixture.toString('utf8')));
  });

  it('records exact byte ranges for every line', () => {
    const { lines } = tailOf([fixture]);
    for (const line of lines) {
      const bytes = fixture.subarray(line.start, line.end).toString('utf8');
      expect(bytes.endsWith('\n')).toBe(true);
      expect(normalizeLine(bytes.trimEnd())).toEqual(line.events);
    }
    expect(lines.at(-1)?.end).toBe(fixture.length);
  });

  it('indexes turns from each prompt, not from compaction summaries', () => {
    const { tail } = tailOf([fixture]);
    expect(tail.turns.map((t) => [t.n, t.uuid, t.source])).toEqual([
      [1, 'u1', 'human'],
      [2, 'u2', 'task'],
      [3, 'u4', 'human'],
      [4, 'u5', 'human'],
      [5, 'u7', 'human']
    ]);
    const turns = tail.turns;
    for (let i = 0; i < turns.length - 1; i++) expect(turns[i].end).toBe(turns[i + 1].start);
    expect(turns.at(-1)?.end).toBeNull();
    expect(turns[0].preview).toBe('Add a retry to fetchUser — and keep the tests green');
  });

  it('knows where each tool call and its result are', () => {
    const { tail } = tailOf([fixture]);
    const bash = tail.tool('t3');
    expect(bash?.name).toBe('Bash');
    const result = fixture.subarray(bash!.result!.start, bash!.result!.end).toString('utf8');
    expect(result).toContain('retries twice');
    expect(tail.tool('t5')?.result).toBeNull();
    expect(tail.tool('nope')).toBeUndefined();
  });

  it('forgets the oldest tool calls past its limit', () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `a${i}`,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }]
        }
      })
    );
    const tail = new TranscriptTail({ toolLimit: 3 });
    tail.feed(Buffer.from(`${lines.join('\n')}\n`));
    expect(['t0', 't1', 't2', 't3', 't4'].map((id) => tail.tool(id) !== undefined)).toEqual([
      false,
      false,
      true,
      true,
      true
    ]);
  });

  it('holds an unfinished last line until the rest arrives', () => {
    const cut = fixture.indexOf('"u4"');
    const { tail, lines } = tailOf([fixture.subarray(0, cut)]);
    const before = lines.length;
    expect(tail.position).toBe(cut);
    expect(tail.lineEnd).toBeLessThan(cut);
    tail.feed(fixture.subarray(cut));
    expect(lines.length).toBeGreaterThan(before);
    expect(lines.map((l) => l.events.map((e) => e.uuid)).flat()).toContain('u4');
  });

  it('starts the turn index over on /clear', () => {
    const { tail } = tailOf([
      fixture,
      Buffer.from(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } })}\n` +
          `${JSON.stringify({ type: 'user', uuid: 'n1', origin: { kind: 'human' }, message: { role: 'user', content: 'fresh' } })}\n`
      )
    ]);
    expect(tail.turns.map((t) => [t.n, t.uuid])).toEqual([[1, 'n1']]);
    expect(tail.tool('t1')).toBeUndefined();
  });

  describe('reading a file', () => {
    let dir: string;
    let path: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'fleet-tail-'));
      path = join(dir, 's.jsonl');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reads only what the file gained, sync and async alike', async () => {
      const half = fixture.indexOf('"u4"');
      writeFileSync(path, fixture.subarray(0, half));
      const asyncLines: TailLine[] = [];
      const syncLines: TailLine[] = [];
      const a = new TranscriptTail({ onLine: (l) => asyncLines.push(l) });
      const s = new TranscriptTail({ onLine: (l) => syncLines.push(l) });
      await a.read(path);
      s.readSync(path);
      appendFileSync(path, fixture.subarray(half));
      await a.read(path);
      s.readSync(path);
      expect(asyncLines).toEqual(tailOf([fixture]).lines);
      expect(syncLines).toEqual(asyncLines);
    });

    it('starts over when the file is replaced by a shorter one', async () => {
      writeFileSync(path, fixture);
      let resets = 0;
      const lines: TailLine[] = [];
      const tail = new TranscriptTail({ onLine: (l) => lines.push(l), onReset: () => resets++ });
      await tail.read(path);
      truncateSync(path, 0);
      const fresh = `${JSON.stringify({ type: 'user', uuid: 'z', origin: { kind: 'human' }, message: { role: 'user', content: 'again' } })}\n`;
      writeFileSync(path, fresh);
      lines.length = 0;
      await tail.read(path);
      expect(resets).toBe(1);
      expect(lines.map((l) => l.events[0]?.uuid)).toEqual(['z']);
      expect(tail.turns.map((t) => t.uuid)).toEqual(['z']);
    });

    it('does nothing for a file that does not exist yet', async () => {
      const tail = new TranscriptTail();
      await tail.read(path);
      tail.readSync(path);
      expect(tail.position).toBe(0);
    });

    it('reads a recorded turn back from disk', async () => {
      writeFileSync(path, fixture);
      const tail = new TranscriptTail();
      await tail.read(path);
      const first = tail.turns[0];
      const lines = await readTranscriptRange(path, { start: first.start, end: first.end! });
      const kinds = lines.flatMap((l) => l.events.map((e) => e.kind));
      expect(kinds[0]).toBe('user_prompt');
      expect(kinds).toContain('tool_result');
      expect(lines[0].start).toBe(first.start);
      expect(await readTranscriptRange(join(dir, 'gone.jsonl'), { start: 0, end: 10 })).toEqual([]);
    });
  });
});
