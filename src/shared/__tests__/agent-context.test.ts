import { describe, it, expect } from 'vitest';
import {
  EMPTY_AGENT_USAGE,
  textMessage,
  type AgentAttachment,
  type AgentMessage,
  type AgentTurnUsage
} from '../agent-types';
import type { AgentToolCall } from '../agent-tools';
import {
  CLEARED_RESULT_TEXT,
  CLEAR_KEEP_RECENT,
  CLEAR_MIN_TOKENS,
  COMPACT_MIN_OLDER,
  canCompact,
  clearedCallIds,
  contextUsed,
  estimateTokens,
  estimateTranscriptTokens,
  shouldCompact,
  splitForCompaction,
  withClearedResults
} from '../agent-context';

const msg = (role: AgentMessage['role'], content: string, reasoning = ''): AgentMessage => ({
  ...textMessage(`${role}-${content}`, role, content),
  reasoning
});

/** A transcript of `turns` complete exchanges, oldest first. */
const conversation = (turns: number): AgentMessage[] =>
  Array.from({ length: turns }, (_, i) => [msg('user', `q${i}`), msg('assistant', `a${i}`)]).flat();

describe('estimateTokens', () => {
  it('grows with the text and is always a whole number', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x'.repeat(35))).toBe(10);
    expect(estimateTokens('x'.repeat(70))).toBe(20);
  });

  it('rounds up, so short strings are never free', () => {
    expect(estimateTokens('x')).toBe(1);
  });
});

describe('estimateTranscriptTokens', () => {
  it('counts the system prompt along with the messages', () => {
    const messages = [msg('user', 'x'.repeat(35))];

    expect(estimateTranscriptTokens(messages, 'y'.repeat(35))).toBeGreaterThan(
      estimateTranscriptTokens(messages)
    );
  });

  it('ignores reasoning, which is shown but never sent back', () => {
    expect(estimateTranscriptTokens([msg('assistant', 'hi', 'z'.repeat(1000))])).toBe(
      estimateTranscriptTokens([msg('assistant', 'hi')])
    );
  });

  /*
   * Attachments stay in context for the life of the conversation, so they are
   * resent with every turn - which makes them the one thing a user can add that
   * silently costs more each time. If they were counted as free, a thread with
   * four screenshots in it would overflow the window with a bar reading empty.
   */
  describe('attachments', () => {
    const withAttachment = (attachment: AgentAttachment): AgentMessage => ({
      ...msg('user', 'look'),
      parts: [
        { type: 'text', text: 'look' },
        { type: 'attachment', attachment }
      ]
    });

    it('charges for a picture, which no character count would notice', () => {
      const shot = withAttachment({
        kind: 'image',
        path: '/repo/shot.png',
        mimeType: 'image/png',
        name: 'shot.png'
      });

      expect(estimateTranscriptTokens([shot])).toBeGreaterThan(
        estimateTranscriptTokens([msg('user', 'look')]) + 1000
      );
    });

    // A PDF is words by the time it is attached, so it costs what its words do.
    it('charges a PDF for the text that came out of it', () => {
      const short = withAttachment({
        kind: 'pdf',
        name: 'a.pdf',
        text: 'x'.repeat(35),
        pages: 1,
        scanned: false
      });
      const long = withAttachment({
        kind: 'pdf',
        name: 'a.pdf',
        text: 'x'.repeat(3500),
        pages: 40,
        scanned: false
      });

      expect(estimateTranscriptTokens([long]) - estimateTranscriptTokens([short])).toBe(990);
    });

    it('charges a mention for the file it re-reads every turn', () => {
      const mention = withAttachment({ kind: 'mention', path: '/repo/src/a.ts' });

      expect(estimateTranscriptTokens([mention])).toBeGreaterThan(
        estimateTranscriptTokens([msg('user', 'look')]) + 1000
      );
    });

    // A `read` that came back with a picture puts one on the wire too, and it
    // is charged the same as one the user attached.
    it('charges for a picture a tool call came back with', () => {
      const call = {
        id: 'c1',
        name: 'read',
        args: '{"path":"shot.png"}',
        result: 'shot.png is an image. It is shown below.',
        error: null,
        summary: '42 KB',
        image: { path: '/repo/shot.png', mimeType: 'image/png' },
        todos: null,
        task: null
      };
      const looked: AgentMessage = {
        ...msg('assistant', ''),
        parts: [{ type: 'tool', call }]
      };
      const read: AgentMessage = {
        ...looked,
        parts: [{ type: 'tool', call: { ...call, image: null } }]
      };

      expect(estimateTranscriptTokens([looked]) - estimateTranscriptTokens([read])).toBe(1600);
    });
  });
});

describe('clearing old tool results', () => {
  /** A finished call, with a result big enough to be worth clearing. */
  const call = (id: string, name: string, resultChars = 40_000): AgentToolCall => ({
    id,
    name,
    args: '{}',
    result: 'x'.repeat(resultChars),
    error: null,
    summary: '200 lines',
    image: null,
    todos: null,
    task: null
  });

  /** An assistant turn that made these calls, in order. */
  const called = (...calls: AgentToolCall[]): AgentMessage => ({
    ...msg('assistant', ''),
    parts: calls.map((c) => ({ type: 'tool', call: c }))
  });

  /** Enough old reads to clear, plus `keepRecent` fresh ones after them. */
  const longRun = (): AgentMessage[] => [
    called(call('old1', 'read'), call('old2', 'read')),
    called(...Array.from({ length: CLEAR_KEEP_RECENT }, (_, i) => call(`new${i}`, 'read', 10)))
  ];

  it('clears old reproducible results once there is enough to gain', () => {
    expect(clearedCallIds(longRun())).toEqual(new Set(['old1', 'old2']));
  });

  it('keeps the most recent calls whatever they cost', () => {
    const ids = clearedCallIds([
      called(...Array.from({ length: CLEAR_KEEP_RECENT }, (_, i) => call(`c${i}`, 'read')))
    ]);

    expect(ids).toEqual(new Set());
  });

  /*
   * The guard that stops a rewrite costing more than it saves. Every provider
   * caches on an exact prefix, so clearing one small result throws away the
   * cached prefix behind it to save a few hundred tokens.
   */
  it('does nothing when there is too little to be worth breaking the cache for', () => {
    const barely = Math.floor((CLEAR_MIN_TOKENS * 3.5) / 2) - 1;
    const ids = clearedCallIds([
      called(call('old1', 'read', barely)),
      called(...Array.from({ length: CLEAR_KEEP_RECENT }, (_, i) => call(`new${i}`, 'read', 10)))
    ]);

    expect(ids).toEqual(new Set());
  });

  /*
   * The whole safety property. Nothing about a command line says whether
   * running it twice is free, and an edit describes a change that happened
   * once, so neither may be thrown away and re-derived.
   */
  it('never clears a tool that cannot simply be run again', () => {
    for (const name of ['bash', 'edit', 'write', 'terminal', 'image', 'mcp__linear__search']) {
      const ids = clearedCallIds([
        called(call('old1', name), call('old2', name)),
        called(...Array.from({ length: CLEAR_KEEP_RECENT }, (_, i) => call(`new${i}`, 'read', 10)))
      ]);

      expect(ids, `${name} must survive`).toEqual(new Set());
    }
  });

  it('leaves a failed call alone, since the reason is why the next rounds went as they did', () => {
    const failed: AgentToolCall = { ...call('old1', 'read'), result: null, error: 'no such file' };
    const ids = clearedCallIds([
      called(failed, call('old2', 'read')),
      called(...Array.from({ length: CLEAR_KEEP_RECENT }, (_, i) => call(`new${i}`, 'read', 10)))
    ]);

    expect(ids.has('old1')).toBe(false);
  });

  it('replaces the result and the picture it came with, and nothing else', () => {
    const withImage: AgentToolCall = {
      ...call('old1', 'read'),
      image: { path: '/repo/shot.png', mimeType: 'image/png' }
    };
    const cleared = withClearedResults([
      called(withImage, call('old2', 'read')),
      called(...Array.from({ length: CLEAR_KEEP_RECENT }, (_, i) => call(`new${i}`, 'read', 10)))
    ]);

    const part = cleared[0].parts[0];
    if (part.type !== 'tool') throw new Error('expected a tool part');
    expect(part.call.result).toBe(CLEARED_RESULT_TEXT);
    expect(part.call.image).toBeNull();
    // The call itself survives, so the model still knows it read the file.
    expect(part.call.name).toBe('read');
    expect(part.call.args).toBe('{}');
  });

  it('returns the transcript itself when there is nothing to do', () => {
    const messages = [called(call('c1', 'read', 10))];

    expect(withClearedResults(messages)).toBe(messages);
  });

  /*
   * The loop guard. A second pass sees placeholders where it left them, and
   * must not count them as a saving available all over again - otherwise every
   * round rewrites the same messages and invalidates the cache forever.
   */
  it('is settled after one pass', () => {
    const once = withClearedResults(longRun());

    expect(clearedCallIds(once)).toEqual(new Set());
    expect(withClearedResults(once)).toBe(once);
  });

  it('does not touch the transcript it was given', () => {
    const messages = longRun();
    withClearedResults(messages);

    const part = messages[0].parts[0];
    if (part.type !== 'tool') throw new Error('expected a tool part');
    expect(part.call.result).toBe('x'.repeat(40_000));
  });

  it('shrinks what the request is estimated to cost', () => {
    const messages = longRun();

    expect(estimateTranscriptTokens(withClearedResults(messages))).toBeLessThan(
      estimateTranscriptTokens(messages) - CLEAR_MIN_TOKENS
    );
  });
});

describe('contextUsed', () => {
  const turn = (contextTokens: number | null): AgentTurnUsage => ({
    billed: { ...EMPTY_AGENT_USAGE, promptTokens: 9000, totalTokens: 9500 },
    contextTokens,
    calls: 9,
    model: null,
    provider: null
  });

  it('trusts the provider over the estimate', () => {
    expect(contextUsed(turn(1000), 12)).toBe(1000);
  });

  it('reads the last round rather than what the turn was billed for', () => {
    // Nine rounds resent the same conversation nine times. The window holds one.
    expect(contextUsed(turn(1000), 12)).toBe(1000);
  });

  it('falls back to the estimate when no usage was reported', () => {
    expect(contextUsed(null, 12)).toBe(12);
    expect(contextUsed(turn(null), 12)).toBe(12);
  });
});

describe('shouldCompact', () => {
  it('fires once the transcript reaches the threshold', () => {
    expect(shouldCompact(79_000, 100_000, 0.8)).toBe(false);
    expect(shouldCompact(80_000, 100_000, 0.8)).toBe(true);
    expect(shouldCompact(95_000, 100_000, 0.8)).toBe(true);
  });

  it('never fires without a threshold, which is the user saying no', () => {
    expect(shouldCompact(99_000, 100_000, null)).toBe(false);
  });

  it('never fires without a context limit, rather than guessing one', () => {
    // A model the catalog has never heard of. Compacting a healthy conversation
    // is worse than letting a rare overflow surface as the provider's error.
    expect(shouldCompact(9_000_000, null, 0.8)).toBe(false);
    expect(shouldCompact(9_000_000, 0, 0.8)).toBe(false);
  });
});

describe('splitForCompaction', () => {
  it('keeps the recent tail and offers the rest for summarizing', () => {
    const messages = conversation(5);
    const { older, recent } = splitForCompaction(messages, 4);

    expect(older).toEqual(messages.slice(0, 6));
    expect(recent).toEqual(messages.slice(6));
  });

  it('takes nothing from a transcript shorter than the tail it keeps', () => {
    const messages = conversation(2);

    expect(splitForCompaction(messages, 4)).toEqual({ older: [], recent: messages });
  });

  it('moves the cut back so the tail opens with a question, not an answer', () => {
    // An odd number of messages would otherwise leave `recent` starting on the
    // assistant reply to a question that had just been summarized away.
    const messages = [...conversation(3), msg('assistant', 'continued')];
    const { older, recent } = splitForCompaction(messages, 4);

    expect(recent[0].role).toBe('user');
    expect(older).toEqual(messages.slice(0, 2));
    expect([...older, ...recent]).toEqual(messages);
  });

  it('loses nothing: the two halves always rebuild the transcript', () => {
    for (const turns of [1, 2, 3, 4, 8]) {
      const messages = conversation(turns);
      const { older, recent } = splitForCompaction(messages, 4);
      expect([...older, ...recent]).toEqual(messages);
    }
  });
});

describe('canCompact', () => {
  it('is false until there is more than the recent tail to fold up', () => {
    expect(canCompact(conversation(2), 4)).toBe(false);
    expect(canCompact(conversation(3), 4)).toBe(true);
  });

  it('is false again once a transcript has just been compacted', () => {
    // The loop guard. A compaction that did not free enough space must not be
    // able to fire again on its own result, summarizing its own summary.
    const compacted = [msg('summary', 'what came before'), ...conversation(2)];

    expect(canCompact(compacted, 4)).toBe(false);
  });

  it('will fold an older summary back in once the conversation has moved on', () => {
    const compacted = [msg('summary', 'what came before'), ...conversation(4)];
    const { older } = splitForCompaction(compacted, 4);

    expect(canCompact(compacted, 4)).toBe(true);
    expect(older.length).toBeGreaterThanOrEqual(COMPACT_MIN_OLDER);
    expect(older[0].role).toBe('summary');
  });
});
