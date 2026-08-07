import { describe, it, expect } from 'vitest';
import { EMPTY_AGENT_IMAGE_CONFIG } from '../../../shared/agent-types';
import type { AgentImageBytes } from '../../../shared/agent-tools';
import { generateImage, toImageBody, type ImageCallRequest } from '../images';

/** One base64 payload, so a test can say "these bytes" without spelling them. */
const PIXEL = Buffer.from('a picture').toString('base64');

function request(over: Partial<ImageCallRequest> = {}): ImageCallRequest {
  return {
    apiKey: 'sk-or-test',
    model: 'test/model',
    prompt: 'a teal officer cap',
    references: [],
    aspectRatio: null,
    config: { ...EMPTY_AGENT_IMAGE_CONFIG, model: 'test/model' },
    onPartial: () => {},
    ...over
  };
}

/** A response whose body is an SSE stream of the given lines. */
function sse(lines: string[], status = 200): Response {
  return new Response(lines.map((l) => `${l}\n`).join(''), {
    status,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function event(payload: object): string {
  return `data: ${JSON.stringify(payload)}`;
}

/**
 * A fetch that answers with `res`. What gets *sent* is `toImageBody`'s job and
 * is checked directly above, so nothing here needs to inspect the request.
 */
function stub(res: Response): typeof fetch {
  return (async () => Promise.resolve(res)) as unknown as typeof fetch;
}

const signal = new AbortController().signal;

describe('toImageBody', () => {
  it('asks for one streamed image and nothing the user did not set', () => {
    expect(toImageBody(request())).toEqual({
      model: 'test/model',
      prompt: 'a teal officer cap',
      n: 1,
      stream: true
    });
  });

  it('sends the settings the user chose, and the ratio the call asked for', () => {
    const body = toImageBody(
      request({
        aspectRatio: '16:9',
        config: { model: 'test/model', resolution: '2K', quality: 'high', seed: 7 }
      })
    );
    expect(body).toMatchObject({
      aspect_ratio: '16:9',
      resolution: '2K',
      quality: 'high',
      seed: 7
    });
  });

  it('turns references into input_references, which is what makes it an edit', () => {
    const body = toImageBody(request({ references: ['data:image/png;base64,AAA'] }));
    expect(body.input_references).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
    ]);
  });

  it('leaves a seed of 0 in - it is a seed, not an absence of one', () => {
    const body = toImageBody(
      request({ config: { ...EMPTY_AGENT_IMAGE_CONFIG, model: 'm', seed: 0 } })
    );
    expect(body.seed).toBe(0);
  });
});

describe('generateImage', () => {
  it('reports every partial and resolves with the finished image', async () => {
    const partials: AgentImageBytes[] = [];
    const res = sse([
      ': keep-alive',
      event({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: PIXEL }),
      event({ type: 'image_generation.partial_image', partial_image_index: 1, b64_json: PIXEL }),
      event({
        type: 'image_generation.completed',
        b64_json: PIXEL,
        media_type: 'image/webp',
        usage: { cost: 0.042 }
      }),
      'data: [DONE]'
    ]);

    const image = await generateImage(
      request({ onPartial: (p) => partials.push(p) }),
      signal,
      stub(res)
    );

    expect(partials).toHaveLength(2);
    expect(Buffer.from(partials[0].data).toString()).toBe('a picture');
    expect(image.mimeType).toBe('image/webp');
    expect(image.costUsd).toBe(0.042);
    expect(Buffer.from(image.data).toString()).toBe('a picture');
  });

  it('defaults to png when the provider names no media type', async () => {
    const res = sse([event({ type: 'image_generation.completed', b64_json: PIXEL })]);
    const image = await generateImage(request(), signal, stub(res));
    expect(image.mimeType).toBe('image/png');
    expect(image.costUsd).toBeNull();
  });

  it('fails on an error event rather than waiting for an image that is not coming', async () => {
    const res = sse([
      event({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: PIXEL }),
      event({ type: 'error', error: { message: 'content policy', code: 'refused' } })
    ]);
    await expect(generateImage(request(), signal, stub(res))).rejects.toThrow('content policy');
  });

  it('fails when the stream ends after partials and no finished image', async () => {
    const res = sse([
      event({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: PIXEL })
    ]);
    await expect(generateImage(request(), signal, stub(res))).rejects.toThrow(
      'ended before an image arrived'
    );
  });

  it('reads the plain body from a provider that ignored stream', async () => {
    const res = new Response(
      JSON.stringify({ data: [{ b64_json: PIXEL }], usage: { cost: 0.01 } }),
      { headers: { 'content-type': 'application/json' } }
    );
    const image = await generateImage(request(), signal, stub(res));
    expect(Buffer.from(image.data).toString()).toBe('a picture');
    expect(image.costUsd).toBe(0.01);
  });

  it('reports what the API said went wrong', async () => {
    const res = new Response(JSON.stringify({ error: { message: 'no credits' } }), { status: 402 });
    await expect(generateImage(request(), signal, stub(res))).rejects.toThrow('no credits');
  });

  it('skips a line that is not readable rather than failing the generation', async () => {
    const res = sse([
      'data: {not json',
      event({ type: 'something.else', b64_json: PIXEL }),
      event({ type: 'image_generation.completed', b64_json: PIXEL })
    ]);
    await expect(generateImage(request(), signal, stub(res))).resolves.toBeDefined();
  });
});
