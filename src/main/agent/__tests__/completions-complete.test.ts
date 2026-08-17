import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeOnce } from '../completions';
import { openRouterTarget } from '../openrouter';

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
  target: openRouterTarget('sk-or-test'),
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

/**
 * Asking again, and knowing when not to.
 *
 * A turn that fails on a rate limit or a gateway hiccup used to end there, and
 * a turn that fails is a pane the user has to notice and restart. What matters
 * as much is the other half: a request that will fail identically next time
 * should say so at once rather than making the user wait out two more attempts
 * to be told their key is wrong.
 */
describe('completeOnce retries', () => {
  /** Answers with each status in turn, then a good completion. */
  function failing(statuses: number[]): { calls: () => number } {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const attempt = call++;
        return Promise.resolve(
          attempt < statuses.length
            ? new Response(JSON.stringify({ error: { message: 'busy' } }), {
                status: statuses[attempt]
              })
            : new Response(JSON.stringify({ choices: [{ message: { content: 'safe' } }] }), {
                status: 200
              })
        );
      })
    );
    return { calls: () => call };
  }

  const call = async (): Promise<{ text: string }> => completeOnce({ ...request, reasoning: null });

  it('gets the answer that came after a rate limit', async () => {
    const { calls } = failing([429]);

    await expect(call()).resolves.toMatchObject({ text: 'safe' });
    expect(calls()).toBe(2);
  });

  it('gives up after the third attempt rather than asking forever', async () => {
    const { calls } = failing([503, 503, 503]);

    await expect(call()).rejects.toThrow('busy');
    expect(calls()).toBe(3);
  });

  // A bad key is not a busy server. Asking twice more only delays the message
  // that tells the user what to fix.
  it('does not ask again about a request that will fail the same way', async () => {
    const { calls } = failing([401]);

    await expect(call()).rejects.toThrow('busy');
    expect(calls()).toBe(1);
  });

  // A cancel is an answer. Nothing should be retried on the user's behalf after
  // they have said to stop.
  it('does not ask again once the caller has cancelled', async () => {
    const controller = new AbortController();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        controller.abort();
        return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      })
    );

    await expect(
      completeOnce({ ...request, reasoning: null, signal: controller.signal })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
