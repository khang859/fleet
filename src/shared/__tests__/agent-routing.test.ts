import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_CACHE,
  DEFAULT_AGENT_FALLBACK,
  DEFAULT_AGENT_PROVIDER,
  FALLBACK_MAX_MODELS,
  cacheControl,
  modelsBody,
  providerBody
} from '../agent-routing';

/**
 * Three request-level controls, and one rule that binds them: a configuration
 * nobody has touched must send nothing at all. Every one of these returns
 * `null` or `{}` for its defaults, because an empty `provider: {}` is harmless
 * today and is exactly the kind of thing that stops being harmless when a
 * default changes at the other end.
 */

describe('provider routing', () => {
  it('sends nothing at all when nothing has been set', () => {
    expect(providerBody(DEFAULT_AGENT_PROVIDER)).toBeNull();
  });

  it('states only what was set', () => {
    expect(
      providerBody({ ...DEFAULT_AGENT_PROVIDER, sort: 'price', ignore: ['deepinfra'] })
    ).toEqual({ sort: 'price', ignore: ['deepinfra'] });
  });

  /*
   * True is what OpenRouter already does. Restating it would be one more
   * number to keep in step with theirs.
   */
  it('mentions fallbacks only to switch them off', () => {
    expect(providerBody({ ...DEFAULT_AGENT_PROVIDER, allowFallbacks: true })).toBeNull();
    expect(providerBody({ ...DEFAULT_AGENT_PROVIDER, allowFallbacks: false })).toEqual({
      allow_fallbacks: false
    });
  });

  it('sends the price ceilings that are set and omits the ones that are not', () => {
    expect(providerBody({ ...DEFAULT_AGENT_PROVIDER, maxPromptPrice: 2 })).toEqual({
      max_price: { prompt: 2 }
    });
    expect(
      providerBody({ ...DEFAULT_AGENT_PROVIDER, maxPromptPrice: 2, maxCompletionPrice: 8 })
    ).toEqual({ max_price: { prompt: 2, completion: 8 } });
  });

  it('keeps the order it was given, since order is the whole meaning of the field', () => {
    expect(providerBody({ ...DEFAULT_AGENT_PROVIDER, order: ['together', 'fireworks'] })).toEqual({
      order: ['together', 'fireworks']
    });
  });
});

describe('model fallbacks', () => {
  it('sends nothing when there is nothing to fall back to', () => {
    expect(modelsBody(DEFAULT_AGENT_FALLBACK, 'anthropic/claude-sonnet-4.5')).toBeNull();
  });

  /*
   * The chosen model goes first because OpenRouter reads the list as the whole
   * route rather than as the alternatives - a list that omitted it would
   * quietly replace it.
   */
  it('puts the chosen model at the head of the route', () => {
    expect(modelsBody({ models: ['openai/gpt-5.1'] }, 'anthropic/claude-sonnet-4.5')).toEqual([
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-5.1'
    ]);
  });

  it('drops a fallback that is the chosen model again', () => {
    expect(
      modelsBody({ models: ['anthropic/claude-sonnet-4.5'] }, 'anthropic/claude-sonnet-4.5')
    ).toBeNull();
  });

  it('drops a repeated fallback rather than trying it twice', () => {
    expect(modelsBody({ models: ['a', 'a', 'b'] }, 'primary')).toEqual(['primary', 'a', 'b']);
  });

  it('stops at the ceiling, past which failing takes longer than the turn', () => {
    const many = Array.from({ length: FALLBACK_MAX_MODELS + 3 }, (_, i) => `m${i}`);
    expect(modelsBody({ models: many }, 'primary')).toHaveLength(FALLBACK_MAX_MODELS + 1);
  });
});

describe('the cache marker', () => {
  it('is nothing at all when caching is off, so the part is unchanged', () => {
    expect(cacheControl({ enabled: false, longTtl: false })).toEqual({});
  });

  it('asks for the five minute cache by default', () => {
    expect(cacheControl(DEFAULT_AGENT_CACHE)).toEqual({ cache_control: { type: 'ephemeral' } });
  });

  it('asks for the hour only when told to', () => {
    expect(cacheControl({ enabled: true, longTtl: true })).toEqual({
      cache_control: { type: 'ephemeral', ttl: '1h' }
    });
  });

  /*
   * The one default here that is not today's behaviour. Safe: a provider that
   * does not read the marker ignores it.
   */
  it('is on out of the box', () => {
    expect(DEFAULT_AGENT_CACHE.enabled).toBe(true);
  });
});
