import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { coalesceStreamDeltas } from '../stream-emit';

const CHUNK = IPC_CHANNELS.AGENT_STREAM_CHUNK;
const REASONING = IPC_CHANNELS.AGENT_STREAM_REASONING;
const TOOL_START = IPC_CHANNELS.AGENT_TOOL_START;
const DONE = IPC_CHANNELS.AGENT_STREAM_DONE;

let sent: Array<{ channel: string; payload: unknown }>;
let emit: (channel: string, payload: unknown) => void;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  emit = coalesceStreamDeltas((channel, payload) => sent.push({ channel, payload }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('coalesceStreamDeltas', () => {
  it('joins the tokens of one window into a single message', () => {
    emit(CHUNK, { streamId: 's1', delta: 'Hel' });
    emit(CHUNK, { streamId: 's1', delta: 'lo ' });
    emit(CHUNK, { streamId: 's1', delta: 'there' });
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(16);

    expect(sent).toEqual([{ channel: CHUNK, payload: { streamId: 's1', delta: 'Hello there' } }]);
  });

  it('keeps two panes apart', () => {
    emit(CHUNK, { streamId: 's1', delta: 'one' });
    emit(CHUNK, { streamId: 's2', delta: 'two' });
    vi.advanceTimersByTime(16);

    expect(sent).toEqual([
      { channel: CHUNK, payload: { streamId: 's1', delta: 'one' } },
      { channel: CHUNK, payload: { streamId: 's2', delta: 'two' } }
    ]);
  });

  it('keeps reasoning and answer text on their own channels, in arrival order', () => {
    emit(REASONING, { streamId: 's1', delta: 'thinking' });
    emit(CHUNK, { streamId: 's1', delta: 'answering' });
    vi.advanceTimersByTime(16);

    expect(sent).toEqual([
      { channel: REASONING, payload: { streamId: 's1', delta: 'thinking' } },
      { channel: CHUNK, payload: { streamId: 's1', delta: 'answering' } }
    ]);
  });

  // The correctness argument for the whole file: a tool row drawn above the
  // sentence introducing it is the bug this ordering rule exists to prevent.
  it('flushes held text before an unbuffered event rather than letting it overtake', () => {
    emit(CHUNK, { streamId: 's1', delta: 'Let me look.' });
    emit(TOOL_START, { streamId: 's1', callId: 'c1' });

    expect(sent).toEqual([
      { channel: CHUNK, payload: { streamId: 's1', delta: 'Let me look.' } },
      { channel: TOOL_START, payload: { streamId: 's1', callId: 'c1' } }
    ]);
  });

  it('leaves nothing buffered when a turn ends', () => {
    emit(CHUNK, { streamId: 's1', delta: 'the last word' });
    emit(DONE, { streamId: 's1' });

    expect(sent).toEqual([
      { channel: CHUNK, payload: { streamId: 's1', delta: 'the last word' } },
      { channel: DONE, payload: { streamId: 's1' } }
    ]);

    // And the flush that rode out with DONE cancelled the timer rather than
    // leaving it to fire on an empty buffer.
    vi.advanceTimersByTime(16);
    expect(sent).toHaveLength(2);
  });

  it('sends a lone token one window later rather than waiting for a second', () => {
    emit(CHUNK, { streamId: 's1', delta: 'hi' });
    vi.advanceTimersByTime(15);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
  });

  it('passes a payload it does not recognise straight through', () => {
    emit(CHUNK, { streamId: 's1', delta: 'held' });
    emit(CHUNK, 'not a delta');

    expect(sent).toEqual([
      { channel: CHUNK, payload: { streamId: 's1', delta: 'held' } },
      { channel: CHUNK, payload: 'not a delta' }
    ]);
  });

  it('starts a new window after a flush', () => {
    emit(CHUNK, { streamId: 's1', delta: 'first' });
    vi.advanceTimersByTime(16);
    emit(CHUNK, { streamId: 's1', delta: 'second' });
    vi.advanceTimersByTime(16);

    expect(sent).toEqual([
      { channel: CHUNK, payload: { streamId: 's1', delta: 'first' } },
      { channel: CHUNK, payload: { streamId: 's1', delta: 'second' } }
    ]);
  });
});
