import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

import { ConversationReader, parseClaudeTranscript } from '../conversation-reader';

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
