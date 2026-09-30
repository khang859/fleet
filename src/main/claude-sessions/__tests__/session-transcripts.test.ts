import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSignal } from '../phase';
import { SessionTranscripts, signalOf, type WatchFile } from '../session-transcripts';
import { normalizeLine } from '../transcript';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const line = (o: object): string => `${JSON.stringify(o)}\n`;
const prompt = (uuid: string, text: string): string =>
  line({ type: 'user', uuid, origin: { kind: 'human' }, message: { role: 'user', content: text } });
const toolUse = (id: string): string =>
  line({
    type: 'assistant',
    uuid: `a-${id}`,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'rm -rf build' } }]
    }
  });
const REJECTION =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
const rejected = (id: string, text = REJECTION): string =>
  line({
    type: 'user',
    uuid: `r-${id}`,
    toolUseResult: 'User rejected tool use',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }]
    }
  });
const interrupted = (forTool: boolean): string =>
  line({
    type: 'user',
    uuid: `i-${forTool}`,
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: forTool
            ? '[Request interrupted by user for tool use]'
            : '[Request interrupted by user]'
        }
      ]
    }
  });
const queue = (operation: string): string =>
  line({ type: 'queue-operation', operation, timestamp: '2026-09-30T10:00:00.000Z' });

describe('signalOf', () => {
  const first = (text: string) => normalizeLine(text.trimEnd())[0];
  it.each<[string, string, TranscriptSignal | null]>([
    ['a permission answered No', rejected('t'), 'turnStopped'],
    ['Esc on a permission', interrupted(true), 'turnStopped'],
    ['Esc during a turn', interrupted(false), 'turnStopped'],
    ['a queued prompt starting', queue('dequeue'), 'turnStarted'],
    ['a prompt being queued', queue('enqueue'), null],
    ['a queued prompt folded into the turn', queue('remove'), null],
    ['a prompt', prompt('u', 'hi'), null],
    ['a tool call', toolUse('t'), null]
  ])('%s', (_name, text, signal) => {
    expect(signalOf(first(text))).toBe(signal);
  });

  it('does not stop the turn for a rejection that carries feedback', () => {
    const withFeedback = rejected(
      't',
      `${REJECTION}\n\nTo tell you how to proceed, the user said:\nuse trash instead`
    );
    expect(signalOf(first(withFeedback))).toBeNull();
  });
});

describe('SessionTranscripts', () => {
  let dir: string;
  let path: string;
  let signals: Array<[string, TranscriptSignal]>;
  let changed: string[];
  let fire: (() => void) | null;
  let transcripts: SessionTranscripts;
  const watchFile: WatchFile = (_path, onChange) => {
    fire = onChange;
    return () => {
      fire = null;
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-transcripts-'));
    path = join(dir, 's1.jsonl');
    signals = [];
    changed = [];
    fire = null;
    transcripts = new SessionTranscripts({
      onSignal: (sessionId, signal) => signals.push([sessionId, signal]),
      onChange: (sessionId) => changed.push(sessionId),
      watchFile,
      debounceMs: 5
    });
  });

  afterEach(() => {
    transcripts.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a rejection written after the permission request', async () => {
    writeFileSync(path, prompt('u1', 'clean up') + toolUse('t1'));
    // PermissionRequest arrives while the dialog is open.
    transcripts.onHookEvent('s1', path);
    appendFileSync(path, rejected('t1'));
    await transcripts.read('s1');
    expect(signals).toEqual([['s1', 'turnStopped']]);
  });

  it('ignores signals the latest hook event already accounts for', async () => {
    // An old rejection, then a new prompt and a Stop: nothing to settle.
    writeFileSync(path, prompt('u1', 'a') + toolUse('t1') + rejected('t1') + queue('dequeue'));
    transcripts.onHookEvent('s1', path);
    await transcripts.read('s1');
    expect(signals).toEqual([]);
    // Lines written before a hook event that were not read yet are ignored too.
    appendFileSync(path, interrupted(false));
    transcripts.onHookEvent('s1', path);
    await transcripts.read('s1');
    expect(signals).toEqual([]);
  });

  it('reports a queued prompt starting after the Stop', async () => {
    writeFileSync(path, prompt('u1', 'long task') + queue('enqueue'));
    transcripts.onHookEvent('s1', path); // Stop of the running turn
    appendFileSync(path, queue('dequeue') + prompt('u2', 'the queued one'));
    expect(fire).not.toBeNull();
    fire?.();
    await vi.waitFor(() => expect(signals).toEqual([['s1', 'turnStarted']]));
  });

  it('keeps the brief current and says when it changed', async () => {
    writeFileSync(path, prompt('u1', 'fix the login bug'));
    transcripts.onHookEvent('s1', path);
    const read = await transcripts.read('s1');
    expect(read?.brief.state.goal?.value).toBe('fix the login bug');
    expect(read?.tail.turns).toHaveLength(1);
    expect(changed).toEqual(['s1']);
    await transcripts.read('s1');
    expect(changed).toEqual(['s1']);
  });

  it('starts over when the session reports a different transcript', async () => {
    writeFileSync(path, prompt('u1', 'first'));
    transcripts.onHookEvent('s1', path);
    await transcripts.read('s1');
    const other = join(dir, 'other.jsonl');
    writeFileSync(other, prompt('u9', 'second'));
    transcripts.onHookEvent('s1', other);
    const read = await transcripts.read('s1');
    expect(read?.path).toBe(other);
    expect(read?.brief.state.goal?.value).toBe('second');
  });

  it('forgets a session and stops watching it', async () => {
    writeFileSync(path, prompt('u1', 'x'));
    transcripts.onHookEvent('s1', path);
    expect(fire).not.toBeNull();
    transcripts.forget('s1');
    expect(fire).toBeNull();
    expect(await transcripts.read('s1')).toBeNull();
  });

  it('tracks a session whose transcript does not exist yet', async () => {
    transcripts.onHookEvent('s1', path);
    expect((await transcripts.read('s1'))?.tail.position).toBe(0);
    writeFileSync(path, prompt('u1', 'hello'));
    expect((await transcripts.read('s1'))?.brief.state.goal?.value).toBe('hello');
  });
});
