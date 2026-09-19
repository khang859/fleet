import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyWithDecision,
  MIN_SAFE_PROBABILITY,
  readDecision,
  toDecisionBody
} from '../decisions';

/**
 * The decision-model path of auto-approval. Like the text classifier, it can
 * only ever remove a question, so what is checked is that every way it can go
 * wrong - a low chance of yes, an odd answer, an outage - lands on `ask` or `null`.
 */

const input = {
  model: 'typesafe/jev-1.13',
  command: 'npm test',
  cwd: '/repo',
  request: 'run the tests',
  note: null
};

function respond(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const usage = { input_tokens: 300, output_tokens: 1, cost: 0.0000126 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readDecision', () => {
  it('runs a likely yes', () => {
    expect(readDecision({ type: 'noul', noul: 0.92 })).toBe('safe');
    expect(readDecision({ type: 'noul', noul: MIN_SAFE_PROBABILITY })).toBe('safe');
  });

  it('asks on a yes that is not likely enough', () => {
    expect(readDecision({ type: 'noul', noul: 0.69 })).toBe('ask');
    expect(readDecision({ type: 'noul', noul: 0 })).toBe('ask');
  });

  it('reports a missing or malformed answer as no answer', () => {
    for (const answer of [
      undefined,
      null,
      {},
      { type: 'noul' },
      { type: 'noul', noul: '0.9' },
      { type: 'choice', choice: 'safe', probabilities: { safe: 1 } },
      'safe'
    ]) {
      expect(readDecision(answer)).toBeNull();
    }
  });
});

describe('toDecisionBody', () => {
  const question = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.questions as Record<string, Record<string, unknown>>).safe_to_run;

  it('sends the request, folder and command as state and one yes-or-no question', () => {
    const body = toDecisionBody({ ...input, note: 'Installs are fine here.' });

    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state).toBe(
      'The developer asked the agent:\nrun the tests\n\nWorking folder: /repo\n\nProposed shell command:\nnpm test'
    );
    expect(question(body).type).toBe('noul');
    expect(Object.keys(question(body).criteria as object)).toEqual(['true', 'false']);
    expect(question(body).instructions).toContain('Installs are fine here.');
  });

  it('says the request is not known when there is none', () => {
    for (const request of [null, '  ']) {
      expect(toDecisionBody({ ...input, request }).state).toContain(
        'The developer asked the agent:\n(not known)'
      );
    }
  });

  it('cuts a long request down', () => {
    const state = toDecisionBody({ ...input, request: 'x'.repeat(10_000) }).state as string;

    expect(state.length).toBeLessThan(2_200);
    expect(state).toContain('Proposed shell command:\nnpm test');
  });
});

describe('classifyWithDecision', () => {
  it('posts to the Decisions endpoint with the key', async () => {
    const fetchMock = respond({
      model: input.model,
      answers: {
        safe_to_run: { type: 'noul', noul: 0.98 }
      },
      usage
    });

    await classifyWithDecision('sk-or-test', input);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
  });

  it('returns the verdict and what it cost', async () => {
    respond({
      model: input.model,
      answers: {
        safe_to_run: { type: 'noul', noul: 0.98 }
      },
      usage
    });

    const result = await classifyWithDecision('sk-or-test', input);

    expect(result.verdict).toBe('safe');
    expect(result.usage).toMatchObject({
      billed: { promptTokens: 300, completionTokens: 1, totalTokens: 301, costUsd: 0.0000126 },
      calls: 1,
      model: input.model
    });
  });

  it('bills an answer that did not help', async () => {
    respond({ model: input.model, answers: {}, usage });

    const result = await classifyWithDecision('sk-or-test', input);

    expect(result.verdict).toBeNull();
    expect(result.usage?.billed.promptTokens).toBe(300);
  });

  it('gives no answer when OpenRouter refuses', async () => {
    respond({ error: { code: 402, message: 'Insufficient credits' } }, 402);

    await expect(classifyWithDecision('sk-or-test', input)).resolves.toEqual({
      verdict: null,
      usage: null
    });
  });

  it('gives no answer when the network is down, and does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(classifyWithDecision('sk-or-test', input)).resolves.toEqual({
      verdict: null,
      usage: null
    });
  });
});
