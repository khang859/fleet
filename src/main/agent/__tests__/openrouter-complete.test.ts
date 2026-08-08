import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeOnce } from '../openrouter';

/**
 * What one un-streamed completion puts on the wire.
 *
 * Narrow on purpose: the reasoning parameter is here because leaving it off was
 * not a visible failure. The call succeeded, was billed, and came back with
 * empty content, because a reasoning model had spent the whole budget thinking
 * about a question that wanted one word - and every caller of this reads that
 * empty answer as "the model had nothing to say". `streamCompletion` had always
 * sent the parameter; this one silently did not.
 */

const request = {
  apiKey: 'sk-or-test',
  model: 'openai/gpt-5.6-luna',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 8,
  temperature: 0
};

/** Captures the request body and answers with a well-formed completion. */
function capture(): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: 'safe' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
    })
  );
  return { bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('completeOnce', () => {
  it('sends the reasoning parameter it was given', async () => {
    const { bodies } = capture();

    await completeOnce({ ...request, reasoning: { enabled: false } });

    expect(bodies[0]).toMatchObject({
      model: request.model,
      max_tokens: 8,
      temperature: 0,
      stream: false,
      reasoning: { enabled: false }
    });
  });

  /*
   * Null is "say nothing about it", not "turn it off" - the same meaning it has
   * on a stream. A key present with a null value would be us stating a
   * preference we do not have.
   */
  it('leaves the parameter off entirely when there is nothing to say', async () => {
    const { bodies } = capture();

    await completeOnce({ ...request, reasoning: null });

    expect(bodies[0]).not.toHaveProperty('reasoning');
  });
});
