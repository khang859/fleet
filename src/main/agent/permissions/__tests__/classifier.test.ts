import { describe, expect, it, vi } from 'vitest';
import type { completeOnce } from '../../openrouter';
import { classifyCommand, readVerdict, toClassifyMessages } from '../classifier';

/**
 * The classifier can only ever remove a question, so what is checked here is
 * that every way it can go wrong - a refusal, a paragraph, an outage - lands on
 * `ask`, which is the answer the agent gives when there is no classifier at all.
 */

const input = {
  apiKey: 'sk-or-test',
  model: 'anthropic/claude-haiku-4.5',
  command: 'npm test',
  cwd: '/repo',
  note: null
};

/** A model that answers with whatever it is handed. */
function answering(text: string): typeof completeOnce {
  return vi.fn(async () => Promise.resolve({ text, usage: null }));
}

describe('readVerdict', () => {
  it('takes a plain yes', () => {
    expect(readVerdict('safe')).toBe('safe');
  });

  it('takes one the model dressed up', () => {
    for (const raw of ['Safe', '  safe\n', '`safe`', '"safe."', '**SAFE**', 'safe - reads only']) {
      expect(readVerdict(raw)).toBe('safe');
    }
  });

  it('takes the answer it was asked for', () => {
    expect(readVerdict('ask')).toBe('ask');
  });

  /*
   * Everything below is a model that did not do as it was told. None of it is
   * consent, and a parser that guessed at any of it would be inventing one.
   */
  it('treats anything else it said as a question for the user', () => {
    for (const raw of [
      'unsafe',
      'safety: this command is fine to run',
      'I cannot answer that',
      'This looks safe to me',
      'sûr',
      'yes'
    ]) {
      expect(readVerdict(raw)).toBe('ask');
    }
  });

  /*
   * Saying nothing is not one of the things a model can mean about a command.
   * It is a reasoning model that spent the budget thinking, or a provider that
   * returned an empty choice - and either way there is no judgement here to
   * remember. Still not consent: the caller asks the user on null too.
   */
  it('reports having no answer as no answer, not as a question', () => {
    for (const raw of ['', '   ', '\n\t ']) {
      expect(readVerdict(raw)).toBeNull();
    }
  });
});

describe('toClassifyMessages', () => {
  it('sends the command whole, and where it would run', () => {
    const messages = toClassifyMessages({ ...input, command: 'rm -rf node_modules && npm ci' });

    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'Working folder: /repo\n\nCommand:\nrm -rf node_modules && npm ci'
    });
  });

  it('carries the user’s note into the instructions', () => {
    const messages = toClassifyMessages({ ...input, note: 'Installs are fine in this container.' });

    expect(messages[0].content).toContain('Installs are fine in this container.');
  });
});

describe('classifyCommand', () => {
  it('asks with no sampling and no thinking', async () => {
    const complete = answering('safe');
    await classifyCommand(complete, input);

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: input.model,
        temperature: 0,
        // Not null, which would leave the model's own default in place. The
        // classifier model falls through to the coding model, so that default
        // is a reasoning model's default more often than not, and the whole
        // budget would go on thinking.
        reasoning: { enabled: false }
      })
    );
  });

  /*
   * Room for the word to arrive after thinking that could not be turned off -
   * some models mark reasoning mandatory and refuse `enabled: false` - but not
   * so much room that a model ignoring the format can bill for an essay.
   */
  it('leaves headroom for a model that thinks anyway, without paying for prose', async () => {
    const complete = answering('safe');
    await classifyCommand(complete, input);

    const [call] = vi.mocked(complete).mock.calls;
    expect(call[0].maxTokens).toBeGreaterThan(64);
    expect(call[0].maxTokens).toBeLessThanOrEqual(512);
  });

  it('reports what the judgement cost', async () => {
    const usage = {
      promptTokens: 120,
      completionTokens: 1,
      totalTokens: 121,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.0001
    };
    const complete: typeof completeOnce = async () => Promise.resolve({ text: 'safe', usage });

    await expect(classifyCommand(complete, input)).resolves.toEqual({
      verdict: 'safe',
      // No context figure: its prompt is one command line, not the transcript.
      usage: { billed: usage, contextTokens: null, calls: 1, model: input.model, provider: null }
    });
  });

  it('reports the cost of an answer that did not help either', async () => {
    const complete: typeof completeOnce = async () =>
      Promise.resolve({
        text: 'I would rather not say',
        usage: {
          promptTokens: 120,
          completionTokens: 6,
          totalTokens: 126,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.0002
        }
      });

    const result = await classifyCommand(complete, input);
    expect(result.verdict).toBe('ask');
    expect(result.usage?.billed.costUsd).toBe(0.0002);
  });

  /*
   * A classifier that is down is a classifier that is not there. It reports no
   * answer rather than `ask`, so the gate asks the user this once without
   * recording a judgement no model made - see its cache.
   */
  it('reports no answer when the call fails, rather than a verdict', async () => {
    const complete: typeof completeOnce = async () => Promise.reject(new Error('502 Bad Gateway'));

    await expect(classifyCommand(complete, input)).resolves.toEqual({
      verdict: null,
      usage: null
    });
  });

  /*
   * The reasoning-model shape, which is the one this is really guarding: the
   * call succeeds, is billed, and comes back with nothing in it.
   */
  it('reports no answer when the model returns empty content', async () => {
    const usage = {
      promptTokens: 120,
      completionTokens: 0,
      totalTokens: 120,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 512,
      costUsd: 0.0003
    };
    const complete: typeof completeOnce = async () => Promise.resolve({ text: '', usage });

    const result = await classifyCommand(complete, input);
    expect(result.verdict).toBeNull();
    // Still billed. A call that thought for 512 tokens and said nothing cost
    // money, and a total that drops it is a total that flatters us.
    expect(result.usage?.billed.costUsd).toBe(0.0003);
  });
});
