import { describe, it, expect, vi } from 'vitest';
import { consumeSSE, OpenRouterClient } from '../openrouter-client';

// eslint-disable-next-line @typescript-eslint/require-await
async function* feed(lines: string[]): AsyncIterable<string> {
  // Emit in arbitrary chunk boundaries to exercise the line buffer.
  for (const l of lines) yield l;
}

describe('consumeSSE', () => {
  it('extracts delta content and stops at [DONE]', async () => {
    const out: string[] = [];
    await consumeSSE(
      feed([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
        'data: [DONE]\n'
      ]),
      (d) => out.push(d)
    );
    expect(out.join('')).toBe('Hello');
  });

  it('ignores OpenRouter processing comments', async () => {
    const out: string[] = [];
    await consumeSSE(
      feed([
        ': OPENROUTER PROCESSING\n',
        'data: {"choices":[{"delta":{"content":"x"}}]}\n',
        'data: [DONE]\n'
      ]),
      (d) => out.push(d)
    );
    expect(out.join('')).toBe('x');
  });

  it('handles deltas split across chunk boundaries', async () => {
    const out: string[] = [];
    await consumeSSE(
      feed(['data: {"choices":[{"delta":{"con', 'tent":"hi"}}]}\n', 'data: [DONE]\n']),
      (d) => out.push(d)
    );
    expect(out.join('')).toBe('hi');
  });

  it('throws on a mid-stream error event (HTTP 200 body error)', async () => {
    await expect(
      consumeSSE(
        feed([
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
          'data: {"error":{"message":"rate limited"},"choices":[{"finish_reason":"error","delta":{}}]}\n'
        ]),
        () => {}
      )
    ).rejects.toThrow('rate limited');
  });
});

describe('OpenRouterClient.listModels', () => {
  it('normalizes /models into {id,name,contextLength}', async () => {
    /* eslint-disable @typescript-eslint/require-await */
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'a/b', name: 'B', context_length: 4096 }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    ) as unknown as typeof fetch;
    /* eslint-enable @typescript-eslint/require-await */
    const client = new OpenRouterClient(fakeFetch);
    const models = await client.listModels('sk-test');
    expect(models).toEqual([{ id: 'a/b', name: 'B', contextLength: 4096 }]);
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' })
      })
    );
  });

  it('throws on non-200', async () => {
    /* eslint-disable @typescript-eslint/require-await */
    const fakeFetch = vi.fn(
      async () => new Response('nope', { status: 401 })
    ) as unknown as typeof fetch;
    /* eslint-enable @typescript-eslint/require-await */
    const client = new OpenRouterClient(fakeFetch);
    await expect(client.listModels('bad')).rejects.toThrow();
  });
});
