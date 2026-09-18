import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyWithDecision, readDecision, toDecisionBody } from '../decisions';

/**
 * The decision-model path of auto-approval. Like the text classifier, it can
 * only ever remove a question, so what is checked is that every way it can go
 * wrong - a low confidence, an odd answer, an outage - lands on `ask` or `null`.
 */

const input = {
  model: 'typesafe/jev-1.13',
  command: 'npm test',
  cwd: '/repo',
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
  it('runs a likely safe', () => {
    expect(
      readDecision({
        type: 'choice',
        choice: 'safe',
        probabilities: { safe: 0.95, ask: 0.05 },
        confidence: 0.71
      })
    ).toBe('safe');
  });

  it('asks on a safe that is not likely enough', () => {
    expect(
      readDecision({ type: 'choice', choice: 'safe', probabilities: { safe: 0.7, ask: 0.3 } })
    ).toBe('ask');
  });

  it('ignores a high confidence without the probability behind it', () => {
    expect(readDecision({ type: 'choice', choice: 'safe', confidence: 0.99 })).toBe('ask');
  });

  it('asks on any other choice', () => {
    for (const choice of ['ask', 'Safe', 'unsafe', '']) {
      expect(readDecision({ type: 'choice', choice, probabilities: { [choice]: 1 } })).toBe('ask');
    }
  });

  it('reports a missing or malformed answer as no answer', () => {
    for (const answer of [undefined, null, {}, { type: 'noul', noul: 1 }, 'safe']) {
      expect(readDecision(answer)).toBeNull();
    }
  });
});

describe('toDecisionBody', () => {
  it('sends the command as state and the verdicts as one choice question', () => {
    const body = toDecisionBody({ ...input, note: 'Installs are fine here.' });

    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state).toEqual({ working_folder: '/repo', command: 'npm test' });
    const question = (body.questions as Record<string, Record<string, unknown>>).verdict;
    expect(question.type).toBe('choice');
    expect(Object.keys(question.criteria as object)).toEqual(['safe', 'ask']);
    expect(question.instructions).toContain('Installs are fine here.');
  });
});

describe('classifyWithDecision', () => {
  it('posts to the Decisions endpoint with the key', async () => {
    const fetchMock = respond({
      model: input.model,
      answers: {
        verdict: { type: 'choice', choice: 'safe', probabilities: { safe: 0.99, ask: 0.01 } }
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
        verdict: { type: 'choice', choice: 'safe', probabilities: { safe: 0.99, ask: 0.01 } }
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
