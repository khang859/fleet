import { describe, expect, it, vi } from 'vitest';
import { resolveTitle, sanitizeTitle, toTitleMessages } from '../session-title';
import type { completeOnce } from '../openrouter';
import { EMPTY_AGENT_USAGE, type AgentUsage } from '../../../shared/agent-types';

/**
 * A title is written by whichever model the user picked, including small ones
 * that answer the question and then keep going. What comes back is treated as
 * raw material rather than as a label, and a failure has to leave the session
 * with no title rather than with a bad one.
 */

const complete = (answer: string, usage: AgentUsage | null = null): typeof completeOnce =>
  vi.fn().mockResolvedValue({ text: answer, usage });

/** A priced call, for the tests about what naming a session costs. */
const priced = (costUsd: number): AgentUsage => ({
  ...EMPTY_AGENT_USAGE,
  promptTokens: 120,
  completionTokens: 4,
  totalTokens: 124,
  costUsd
});

const INPUT = { apiKey: 'k', model: 'm', firstUser: 'why is it slow', firstAssistant: 'because…' };

describe('sanitizeTitle', () => {
  it('keeps a title that was already what was asked for', () => {
    expect(sanitizeTitle('Fix the parser')).toBe('Fix the parser');
  });

  it('takes off the wrapping a model adds despite being told not to', () => {
    expect(sanitizeTitle('"Fix the parser"')).toBe('Fix the parser');
    expect(sanitizeTitle('**Fix the parser**')).toBe('Fix the parser');
    expect(sanitizeTitle('`Fix the parser`')).toBe('Fix the parser');
    expect(sanitizeTitle('## Fix the parser')).toBe('Fix the parser');
    expect(sanitizeTitle('Title: Fix the parser')).toBe('Fix the parser');
    expect(sanitizeTitle('Fix the parser.')).toBe('Fix the parser');
  });

  it('collapses the whitespace a wrapped answer arrives with', () => {
    expect(sanitizeTitle('  Fix   the\nparser  ')).toBe('Fix the parser');
  });

  // A model that ignores the length instruction should still produce a label,
  // not a sentence stretched across the row.
  it('cuts a long answer down to a title', () => {
    expect(sanitizeTitle('one two three four five six seven eight')).toBe(
      'one two three four five six'
    );
  });

  it('is empty when there was nothing behind the decoration', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle('   ')).toBe('');
    expect(sanitizeTitle('""')).toBe('');
  });
});

describe('toTitleMessages', () => {
  it('sends the opening exchange, labelled by who said what', () => {
    const [system, user] = toTitleMessages(INPUT);

    expect(system.role).toBe('system');
    expect(user).toMatchObject({
      role: 'user',
      content: 'User: why is it slow\n\nAssistant: because…'
    });
  });

  // A turn can end with nothing from the assistant - cancelled, or refused -
  // and the user's own words are still worth a title.
  it('sends the question alone when the turn produced no answer', () => {
    const [, user] = toTitleMessages({ ...INPUT, firstAssistant: '' });

    expect(user).toMatchObject({ content: 'User: why is it slow' });
  });
});

describe('resolveTitle', () => {
  it('is the sanitized answer when the model gave one', async () => {
    await expect(resolveTitle(complete('"Slow parser"'), INPUT)).resolves.toMatchObject({
      title: 'Slow parser'
    });
  });

  /*
   * Nothing is invented here. A session with no title shows the words the user
   * opened it with, which is a better label than any placeholder, so a failure
   * needs no fallback of its own.
   */
  it('is nothing at all when the call fails', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('OpenRouter responded 429'));

    await expect(resolveTitle(failing, INPUT)).resolves.toEqual({ title: null, usage: null });
  });

  it('is nothing at all when the model answered with nothing usable', async () => {
    await expect(resolveTitle(complete('   '), INPUT)).resolves.toMatchObject({ title: null });
    await expect(resolveTitle(complete('""'), INPUT)).resolves.toMatchObject({ title: null });
  });

  it('reports what the call cost, against the model that answered', async () => {
    const { usage } = await resolveTitle(complete('Slow parser', priced(0.00004)), INPUT);

    expect(usage).toEqual({
      billed: priced(0.00004),
      // Its prompt is two excerpts rather than the transcript, so it says
      // nothing about how full the window is.
      contextTokens: null,
      calls: 1,
      model: 'm',
      provider: null
    });
  });

  /*
   * A model that answered with something unusable was still paid for
   * answering, and a total that quietly dropped those calls would disagree
   * with the invoice in the direction that flatters us.
   */
  it('reports the cost even when the answer was unusable', async () => {
    const { title, usage } = await resolveTitle(complete('   ', priced(0.00004)), INPUT);

    expect(title).toBeNull();
    expect(usage?.billed.costUsd).toBe(0.00004);
  });

  it('asks for few enough tokens that a title cannot become an essay', async () => {
    const spy = complete('Slow parser');
    await resolveTitle(spy, INPUT);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 24, model: 'm' }));
  });
});
