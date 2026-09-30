import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionUsageTracker, contextLimitFor } from '../session-usage';
import type { PriceTable } from '../../../shared/claude-pricing';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const TABLE: PriceTable = {
  schemaVersion: 1,
  updated: '2026-09-30',
  models: [
    {
      prefix: 'claude-opus-5',
      input: 5,
      output: 25,
      cacheReadMult: 0.1,
      cacheWrite5mMult: 1.25,
      cacheWrite1hMult: 2
    }
  ]
};

function line(
  id: string,
  usage: Record<string, number>,
  opts: { model?: string; sidechain?: boolean } = {}
): string {
  return `${JSON.stringify({
    type: 'assistant',
    isSidechain: opts.sidechain ?? false,
    message: { id, model: opts.model ?? 'claude-opus-5', usage }
  })}\n`;
}

describe('contextLimitFor', () => {
  it('uses the standard window until a session is seen past it', () => {
    expect(contextLimitFor(150_000, false)).toBe(200_000);
    expect(contextLimitFor(250_000, false)).toBe(1_000_000);
    // After compacting back under 200k, the session is still on the 1M window.
    expect(contextLimitFor(40_000, true)).toBe(1_000_000);
  });
});

describe('SessionUsageTracker', () => {
  let dir: string;
  let transcript: string;
  let changed: string[];
  let tracker: SessionUsageTracker;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-usage-'));
    transcript = join(dir, 's1.jsonl');
    changed = [];
    now = 10_000;
    tracker = new SessionUsageTracker({
      priceTable: () => TABLE,
      onChange: (id) => changed.push(id),
      throttleMs: 2_000,
      now: () => now
    });
  });

  afterEach(() => {
    tracker.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports unknown usage before the transcript exists', async () => {
    tracker.refresh('s1', transcript, true);
    await tracker.settled('s1');
    expect(tracker.get('s1')).toEqual({ costUsd: null, contextTokens: null, contextLimit: null });
    expect(changed).toEqual([]);
  });

  it('estimates cost and context, and reads only what was appended', async () => {
    writeFileSync(transcript, line('m1', { input_tokens: 1_000_000 }));
    tracker.refresh('s1', transcript, true);
    await tracker.settled('s1');
    expect(tracker.get('s1')).toEqual({
      costUsd: 5,
      contextTokens: 1_000_000,
      contextLimit: 1_000_000
    });

    appendFileSync(
      transcript,
      line('m2', { output_tokens: 1_000_000, cache_read_input_tokens: 20 })
    );
    tracker.refresh('s1', transcript, true);
    await tracker.settled('s1');
    // Had the first line been read again, the cost would be 35, not 30.
    expect(tracker.get('s1').costUsd).toBeCloseTo(30);
    expect(tracker.get('s1').contextTokens).toBe(20);
    expect(changed).toEqual(['s1', 's1']);
  });

  it('adds subagent transcripts to the cost but not to the context', async () => {
    writeFileSync(transcript, line('m1', { input_tokens: 100 }));
    const subagents = join(dir, 's1', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, 'agent-a.jsonl'),
      line('a1', { input_tokens: 1_000_000 }, { sidechain: true })
    );
    tracker.refresh('s1', transcript, true);
    await tracker.settled('s1');
    expect(tracker.get('s1').costUsd).toBeCloseTo(5.0005);
    expect(tracker.get('s1').contextTokens).toBe(100);
  });

  it('holds a line cut off mid-write, including a split character, until it is finished', async () => {
    const full = line('m1', { input_tokens: 1_000_000 }).replace('"m1"', '"m1é"');
    const bytes = Buffer.from(full);
    const cut = bytes.indexOf(Buffer.from('é')) + 1; // inside the two-byte é
    writeFileSync(transcript, bytes.subarray(0, cut));
    tracker.refresh('s1', transcript, true);
    await tracker.settled('s1');
    expect(tracker.get('s1').costUsd).toBeNull();

    appendFileSync(transcript, bytes.subarray(cut));
    tracker.refresh('s1', transcript, true);
    await tracker.settled('s1');
    expect(tracker.get('s1').costUsd).toBeCloseTo(5);
  });

  it('starts over when the transcript is replaced by a shorter one', async () => {
    writeFileSync(
      transcript,
      line('m1', { input_tokens: 1_000_000 }) + line('m2', { input_tokens: 1 })
    );
    tracker.refresh('s1', transcript, true);
    await tracker.settled('s1');
    writeFileSync(transcript, line('m3', { input_tokens: 400_000 }));
    tracker.refresh('s1', transcript, true);
    await tracker.settled('s1');
    expect(tracker.get('s1').costUsd).toBeCloseTo(2);
  });

  it('shows no cost when a model has no price, rather than zero', async () => {
    writeFileSync(transcript, line('m1', { input_tokens: 10 }, { model: 'mystery-model' }));
    tracker.refresh('s1', transcript, true);
    await tracker.settled('s1');
    expect(tracker.get('s1')).toEqual({ costUsd: null, contextTokens: 10, contextLimit: 200_000 });
  });

  it('throttles reads while a session is busy', async () => {
    vi.useFakeTimers();
    try {
      writeFileSync(transcript, line('m1', { input_tokens: 1 }));
      tracker.refresh('s1', transcript);
      await vi.waitFor(() => expect(changed).toHaveLength(1));

      appendFileSync(transcript, line('m2', { input_tokens: 2 }));
      now += 500;
      tracker.refresh('s1', transcript);
      tracker.refresh('s1', transcript);
      await tracker.settled('s1');
      expect(tracker.get('s1').contextTokens).toBe(1);

      now += 1_500;
      await vi.advanceTimersByTimeAsync(1_500);
      await tracker.settled('s1');
      await vi.waitFor(() => expect(tracker.get('s1').contextTokens).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
