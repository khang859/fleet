import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '../agent-types';
import {
  COMPACT_MIN_OLDER,
  canCompact,
  contextUsed,
  estimateTokens,
  estimateTranscriptTokens,
  shouldCompact,
  splitForCompaction
} from '../agent-context';

const msg = (role: AgentMessage['role'], content: string, reasoning = ''): AgentMessage => ({
  id: `${role}-${content}`,
  role,
  content,
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
});

describe('contextUsed', () => {
  it('trusts the provider over the estimate', () => {
    expect(contextUsed({ promptTokens: 900, completionTokens: 100, totalTokens: 1000 }, 12)).toBe(
      1000
    );
  });

  it('falls back to the estimate when no usage was reported', () => {
    expect(contextUsed(null, 12)).toBe(12);
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
