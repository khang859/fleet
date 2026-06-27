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

  it('captures usage + cache hits from the terminal accounting chunk', async () => {
    const res = await consumeSSE(
      feed([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.0012,"prompt_tokens_details":{"cached_tokens":80}}}\n',
        'data: [DONE]\n'
      ]),
      () => {}
    );
    expect(res.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 80,
      cost: 0.0012
    });
  });

  it('returns null usage when the stream carries no accounting chunk', async () => {
    const res = await consumeSSE(
      feed(['data: {"choices":[{"delta":{"content":"hi"}}]}\n', 'data: [DONE]\n']),
      () => {}
    );
    expect(res.usage).toBeNull();
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
    expect(models).toEqual([
      {
        id: 'a/b',
        name: 'B',
        contextLength: 4096,
        supportsTools: false,
        inputImage: false,
        outputImage: false
      }
    ]);
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

it('assembles streamed tool_calls and returns finishReason', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"generate_image","arguments":""}}]},"finish_reason":null}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"prompt\\":\\"a fox"}}]},"finish_reason":null}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]},"finish_reason":null}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
    'data: [DONE]\n'
  ];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    }
  });
  const fakeFetch = (async () =>
    Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;
  const client = new OpenRouterClient(fakeFetch);
  const deltas: string[] = [];
  const result = await client.streamCompletion({
    apiKey: 'k',
    model: 'm',
    messages: [],
    signal: new AbortController().signal,
    onDelta: (d) => deltas.push(d),
    tools: [{ type: 'function' }]
  });
  expect(result.finishReason).toBe('tool_calls');
  expect(result.toolCalls).toEqual([
    { id: 'call_1', name: 'generate_image', arguments: '{"prompt":"a fox"}' }
  ]);
});

describe('OpenRouterClient.complete (task model)', () => {
  it('returns the trimmed assistant content from a non-streaming completion', async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '  Fix login bug  ' } }] }), {
          status: 200
        })
      )
    );
    const client = new OpenRouterClient(fakeFetch as unknown as typeof fetch);
    const text = await client.complete({
      apiKey: 'k',
      model: 'cheap/model',
      messages: [{ role: 'user', content: 'name this' }],
      maxTokens: 16
    });
    expect(text).toBe('Fix login bug');
    const body = JSON.parse((fakeFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: 'cheap/model', stream: false, max_tokens: 16 });
  });

  it('returns empty string when the model produces no content', async () => {
    const fakeFetch = (async () =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })
      )) as unknown as typeof fetch;
    const client = new OpenRouterClient(fakeFetch);
    expect(await client.complete({ apiKey: 'k', model: 'm', messages: [] })).toBe('');
  });

  it('throws on a non-200 response', async () => {
    const fakeFetch = (async () =>
      Promise.resolve(new Response('boom', { status: 500 }))) as unknown as typeof fetch;
    const client = new OpenRouterClient(fakeFetch);
    await expect(client.complete({ apiKey: 'k', model: 'm', messages: [] })).rejects.toThrow();
  });
});

it('maps model capability flags from /models', async () => {
  const json = {
    data: [
      {
        id: 'a/b',
        name: 'B',
        context_length: 1000,
        supported_parameters: ['tools', 'temperature'],
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }
      }
    ]
  };
  const fakeFetch = (async () =>
    Promise.resolve(
      new Response(JSON.stringify(json), { status: 200 })
    )) as unknown as typeof fetch;
  const client = new OpenRouterClient(fakeFetch);
  const models = await client.listModels('k');
  expect(models[0]).toMatchObject({ supportsTools: true, inputImage: true, outputImage: false });
});

it('listImageModels queries output_modalities=image and keeps only image-output models', async () => {
  const json = {
    data: [
      {
        id: 'img/model',
        name: 'Imager',
        context_length: 0,
        architecture: { input_modalities: ['text'], output_modalities: ['image'] }
      },
      {
        id: 'text/model',
        name: 'Texter',
        context_length: 0,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }
      }
    ]
  };
  const fakeFetch = vi.fn(async () =>
    Promise.resolve(new Response(JSON.stringify(json), { status: 200 }))
  ) as unknown as typeof fetch;
  const client = new OpenRouterClient(fakeFetch);
  const models = await client.listImageModels('sk-img');
  expect(models.map((m) => m.id)).toEqual(['img/model']);
  expect(fakeFetch).toHaveBeenCalledWith(
    'https://openrouter.ai/api/v1/models?output_modalities=image',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-img' })
    })
  );
});
