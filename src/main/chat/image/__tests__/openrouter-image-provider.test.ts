import { describe, it, expect, vi } from 'vitest';
import { OpenRouterImageProvider } from '../openrouter-image-provider';

describe('OpenRouterImageProvider', () => {
  it('posts the prompt and decodes b64_json to a Buffer', async () => {
    const b64 = Buffer.from('IMG').toString('base64');
    /* eslint-disable @typescript-eslint/require-await */
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: b64 }], usage: { cost: 0.04 } }), {
          status: 200
        })
    );
    /* eslint-enable @typescript-eslint/require-await */
    const fetchImpl = spy as unknown as typeof fetch;
    const provider = new OpenRouterImageProvider(() => 'sk-test', fetchImpl);
    const result = await provider.generate(
      { prompt: 'a fox', model: 'google/gemini-2.5-flash-image' },
      new AbortController().signal
    );
    expect(result.data.toString()).toBe('IMG');
    expect(result.mimeType).toBe('image/png');
    expect(result.costUsd).toBe(0.04);

    const calls = spy.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toMatchObject({ model: 'google/gemini-2.5-flash-image', prompt: 'a fox' });
    expect(body.input_references).toBeUndefined();
  });

  it('includes input_references when editing', async () => {
    const b64 = Buffer.from('X').toString('base64');
    /* eslint-disable @typescript-eslint/require-await */
    const spy = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 })
    );
    /* eslint-enable @typescript-eslint/require-await */
    const fetchImpl = spy as unknown as typeof fetch;
    const provider = new OpenRouterImageProvider(() => 'sk', fetchImpl);
    await provider.generate(
      { prompt: 'make it night', model: 'm', referenceImages: ['data:image/png;base64,AAA'] },
      new AbortController().signal
    );
    const calls = spy.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.input_references).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
    ]);
  });

  it('throws a clear error on non-200', async () => {
    /* eslint-disable @typescript-eslint/require-await */
    const fetchImpl = vi.fn(
      async () => new Response('blocked', { status: 400 })
    ) as unknown as typeof fetch;
    /* eslint-enable @typescript-eslint/require-await */
    const provider = new OpenRouterImageProvider(() => 'sk', fetchImpl);
    await expect(
      provider.generate({ prompt: 'x', model: 'm' }, new AbortController().signal)
    ).rejects.toThrow(/400/);
  });
});
