import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { addTranscriptFile, aggregateClaudeUsage, UsageAccumulator } from '../usage-accumulator';

function assistantLine(opts: {
  id: string;
  model: string;
  ts?: string;
  branch?: string;
  sidechain?: boolean;
  usage: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${opts.id}-${Math.random()}`,
    timestamp: opts.ts,
    gitBranch: opts.branch,
    isSidechain: opts.sidechain ?? false,
    message: { id: opts.id, model: opts.model, role: 'assistant', usage: opts.usage }
  });
}

describe('aggregateClaudeUsage', () => {
  it('aggregates tokens, dedups by message.id, splits cache writes', () => {
    const jsonl = [
      assistantLine({
        id: 'msg_1',
        model: 'claude-opus-4-8',
        ts: '2026-05-01T10:00:00Z',
        branch: 'feature/x',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 5 }
        }
      }),
      // duplicate message.id (second content-block line) must NOT double-count
      assistantLine({
        id: 'msg_1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 5 }
        }
      }),
      assistantLine({
        id: 'msg_2',
        model: 'claude-opus-4-8',
        ts: '2026-05-01T10:05:00Z',
        // no cache_creation object -> cache_creation_input_tokens counts as 5m
        usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 8 }
      })
    ].join('\n');

    const agg = aggregateClaudeUsage(jsonl);
    expect(agg.total).toEqual({
      input: 300,
      output: 30,
      cacheRead: 50,
      cacheWrite5m: 28, // 20 + 8
      cacheWrite1h: 5
    });
    expect(agg.models).toEqual(['claude-opus-4-8']);
    expect(agg.gitBranch).toBe('feature/x');
    expect(agg.startedAt).toBe(Date.parse('2026-05-01T10:00:00Z'));
    expect(agg.endedAt).toBe(Date.parse('2026-05-01T10:05:00Z'));
    expect(agg.hasUsage).toBe(true);
    expect(agg.perModel.get('claude-opus-4-8')?.input).toBe(300);
  });

  it('tracks multiple models in first-appearance order and includes sidechains', () => {
    const jsonl = [
      assistantLine({ id: 'a', model: 'claude-opus-4-8', usage: { output_tokens: 10 } }),
      assistantLine({
        id: 'b',
        model: 'claude-haiku-4-5',
        sidechain: true,
        usage: { output_tokens: 4 }
      })
    ].join('\n');
    const agg = aggregateClaudeUsage(jsonl);
    expect(agg.models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
    expect(agg.total.output).toBe(14); // sidechain counted
    expect(agg.perModel.get('claude-haiku-4-5')?.output).toBe(4);
    expect(agg.perModel.get('claude-opus-4-8')?.output).toBe(10);
  });

  it('reports hasUsage=false when no assistant usage exists', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    const agg = aggregateClaudeUsage(jsonl);
    expect(agg.hasUsage).toBe(false);
    expect(agg.models).toEqual([]);
  });
});

describe('UsageAccumulator', () => {
  const transcript = [
    JSON.stringify({ type: 'user', timestamp: '2026-05-01T09:59:00Z', gitBranch: 'main' }),
    assistantLine({
      id: 'm1',
      model: 'claude-opus-4-8',
      ts: '2026-05-01T10:00:00Z',
      usage: {
        input_tokens: 3,
        output_tokens: 40,
        cache_read_input_tokens: 12_000,
        cache_creation: { ephemeral_5m_input_tokens: 500 }
      }
    }),
    assistantLine({
      id: 'm1',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 12_000 }
    }),
    assistantLine({
      id: 'sub',
      model: 'claude-haiku-4-5',
      sidechain: true,
      usage: { input_tokens: 90_000, output_tokens: 7 }
    }),
    'not json',
    assistantLine({
      id: 'err',
      model: '<synthetic>',
      ts: '2026-05-01T10:02:00Z',
      usage: { input_tokens: 0, output_tokens: 0 }
    }),
    assistantLine({
      id: 'm2',
      model: 'claude-opus-4-8',
      ts: '2026-05-01T10:03:00Z',
      usage: { input_tokens: 5, output_tokens: 60, cache_read_input_tokens: 12_500 }
    })
  ].join('\n');

  it('gives the same result fed in any chunk sizes as fed whole', () => {
    const whole = aggregateClaudeUsage(transcript);
    for (const size of [1, 7, 64, 333]) {
      const acc = new UsageAccumulator();
      for (let at = 0; at < transcript.length; at += size) {
        acc.addText(transcript.slice(at, at + size));
      }
      acc.flush();
      expect(acc.result()).toEqual(whole);
    }
  });

  it('waits for the rest of a line cut off mid-write', () => {
    const line = assistantLine({ id: 'x', model: 'claude-opus-4-8', usage: { output_tokens: 9 } });
    const acc = new UsageAccumulator();
    acc.addText(line.slice(0, 20));
    expect(acc.result().hasUsage).toBe(false);
    acc.addText(`${line.slice(20)}\n`);
    expect(acc.result().total.output).toBe(9);
  });

  it('takes the context from the last main-chain message with usage', () => {
    const agg = aggregateClaudeUsage(transcript);
    // m2: 5 fresh + 12,500 cache read. The subagent and the zero-usage error line do not count.
    expect(agg.context).toEqual({ tokens: 12_505, model: 'claude-opus-4-8' });
  });

  it('leaves zero-usage API error lines out, so the session stays priced', () => {
    const agg = aggregateClaudeUsage(transcript);
    expect(agg.models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
    expect(agg.perModel.has('<synthetic>')).toBe(false);
  });

  it('reports no context before any main-chain usage', () => {
    const agg = aggregateClaudeUsage(
      assistantLine({
        id: 's',
        model: 'claude-haiku-4-5',
        sidechain: true,
        usage: { input_tokens: 4 }
      })
    );
    expect(agg.context).toBeNull();
  });

  it('returns snapshots that later lines do not change', () => {
    const acc = new UsageAccumulator();
    acc.addLine(assistantLine({ id: 'a', model: 'claude-opus-4-8', usage: { output_tokens: 1 } }));
    const before = acc.result();
    acc.addLine(assistantLine({ id: 'b', model: 'claude-opus-4-8', usage: { output_tokens: 1 } }));
    expect(before.total.output).toBe(1);
    expect(before.perModel.get('claude-opus-4-8')?.output).toBe(1);
  });
});

describe('addTranscriptFile', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('matches reading the file whole when it spans several chunks', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-usage-'));
    const path = join(dir, 'agent-a.jsonl');
    // Over 4 MB of multi-byte padding, so reads split lines and characters.
    const lines = Array.from({ length: 300 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: `2026-05-01T10:${String(i % 60).padStart(2, '0')}:00Z`,
        message: {
          id: `msg_${i}`,
          model: i % 2 ? 'claude-opus-4-8' : 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'é🙂'.repeat(5000 + i) }],
          usage: { input_tokens: i, output_tokens: 2 * i, cache_read_input_tokens: 3 }
        }
      })
    );
    const content = lines.join('\n');
    expect(Buffer.byteLength(content)).toBeGreaterThan(8 * 1024 * 1024);
    writeFileSync(path, content);

    const acc = new UsageAccumulator();
    await addTranscriptFile(acc, path);
    expect(acc.result()).toEqual(aggregateClaudeUsage(content));
  });

  it('rejects for a file it cannot open', async () => {
    await expect(
      addTranscriptFile(new UsageAccumulator(), join(tmpdir(), 'fleet-no-such-file.jsonl'))
    ).rejects.toThrow();
  });
});
