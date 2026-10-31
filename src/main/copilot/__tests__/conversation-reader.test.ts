import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

import { ConversationReader, parseClaudeTranscript, PiMessageTail } from '../conversation-reader';

const FIXTURE = join(__dirname, '../../claude-sessions/__tests__/fixtures/turns.jsonl');
const fixture = readFileSync(FIXTURE);

describe('parseClaudeTranscript on the fixture transcript', () => {
  it('matches the golden chat messages', async () => {
    const messages = parseClaudeTranscript(fixture.toString('utf8'));
    await expect(`${JSON.stringify(messages, null, 2)}\n`).toMatchFileSnapshot(
      '../../claude-sessions/__tests__/fixtures/turns.messages.json'
    );
  });
});

describe('PiMessageTail', () => {
  let dir: string;
  let path: string;

  const line = (id: string, parentId: string | null, role: string, text: string): string =>
    `${JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: '2026-10-31T01:00:00.000Z',
      message: { role, content: [{ type: 'text', text }] }
    })}\n`;

  const texts = (tail: PiMessageTail): string[] =>
    tail.messages.flatMap((m) => m.blocks.flatMap((b) => (b.type === 'text' ? b.text : [])));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-pi-tail-'));
    path = join(dir, 's.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows only the branch the last entry is on', async () => {
    const tail = new PiMessageTail();
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'session', id: 's', cwd: '/x' })}\n` +
        line('a', null, 'user', 'start') +
        line('b', 'a', 'assistant', 'left')
    );
    await tail.read(path);
    expect(texts(tail)).toEqual(['start', 'left']);

    // `/tree` went back to `a`, and the session goes on from there in the same file.
    appendFileSync(path, line('c', 'a', 'user', 'right'));
    await tail.read(path);
    expect(texts(tail)).toEqual(['start', 'right']);
  });

  it('follows the chain through an entry with no message', async () => {
    const tail = new PiMessageTail();
    writeFileSync(
      path,
      line('a', null, 'user', 'start') +
        `${JSON.stringify({ type: 'model_change', id: 'm', parentId: 'a' })}\n` +
        line('b', 'm', 'assistant', 'reply')
    );
    await tail.read(path);
    expect(texts(tail)).toEqual(['start', 'reply']);
  });
});

describe('ConversationReader on a file that does not exist yet', () => {
  it('starts following the session when a change shows the file is there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-reader-late-'));
    const path = join(dir, 's.jsonl');
    const reader = new ConversationReader();
    const changes: number[] = [];
    reader.setOnChange((_id, messages) => changes.push(messages.length));

    expect(reader.getMessages('s', path, 'pi')).toEqual([]);
    reader.watch('s', path);
    expect(reader.getWatchedSessionIds()).toEqual(['s']);

    reader.refresh('s');
    expect(changes).toEqual([]);

    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'message',
        id: 'a',
        parentId: null,
        message: { role: 'user', content: 'hello' }
      })}\n`
    );
    reader.refresh('s');
    expect(changes).toEqual([1]);

    reader.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ConversationReader', () => {
  let dir: string;
  let path: string;
  let reader: ConversationReader;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-reader-'));
    path = join(dir, 's.jsonl');
    reader = new ConversationReader();
  });
  afterEach(() => {
    reader.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a growing transcript to the same messages as a one-pass parse', () => {
    // Cut in the middle of a line: the old reader lost a line cut like this.
    const cut = fixture.indexOf('"u4"') + 20;
    writeFileSync(path, fixture.subarray(0, cut));
    const early = reader.getMessages('s', path).length;
    appendFileSync(path, fixture.subarray(cut));
    const messages = reader.getMessages('s', path);
    expect(messages.length).toBeGreaterThan(early);
    expect(messages).toEqual(parseClaudeTranscript(fixture.toString('utf8')));
  });

  it('starts over when the transcript is replaced by a shorter one', () => {
    writeFileSync(path, fixture);
    expect(reader.getMessages('s', path).length).toBeGreaterThan(1);
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'user', uuid: 'z', message: { role: 'user', content: 'again' } })}\n`
    );
    expect(reader.getMessages('s', path).map((m) => m.id)).toEqual(['z']);
  });

  it('tells a watcher about new messages on refresh', () => {
    writeFileSync(path, '');
    const onChange = vi.fn();
    reader.setOnChange(onChange);
    reader.getMessages('s', path);
    reader.watch('s', path);
    appendFileSync(path, fixture);
    reader.refresh('s');
    expect(onChange).toHaveBeenCalledTimes(1);
    reader.refresh('s');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
