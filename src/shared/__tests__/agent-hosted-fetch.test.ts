import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_HOSTED_FETCH,
  hostedFetchSpec,
  parseHostedFetchResult
} from '../agent-hosted-fetch';

describe('hostedFetchSpec', () => {
  it('sends nothing while the tool is off, which is the default', () => {
    expect(DEFAULT_AGENT_HOSTED_FETCH.enabled).toBe(false);
    expect(hostedFetchSpec(DEFAULT_AGENT_HOSTED_FETCH)).toBeNull();
  });

  it('sends the engine and the use cap once it is on', () => {
    const spec = hostedFetchSpec({ ...DEFAULT_AGENT_HOSTED_FETCH, enabled: true });
    expect(spec?.type).toBe('openrouter:web_fetch');
    expect(spec?.parameters?.engine).toBe('openrouter');
    expect(spec?.parameters?.max_uses).toBe(5);
  });

  /*
   * `auto` is OpenRouter's own default, so saying it and omitting it mean the
   * same thing on the wire and the omission keeps the body honest about what
   * Fleet is actually asking for.
   */
  it('omits an engine of auto rather than stating it', () => {
    const spec = hostedFetchSpec({
      ...DEFAULT_AGENT_HOSTED_FETCH,
      enabled: true,
      engine: 'auto'
    });
    expect(spec?.parameters).not.toHaveProperty('engine');
  });

  it('omits the page limit when the engine is to decide', () => {
    const spec = hostedFetchSpec({ ...DEFAULT_AGENT_HOSTED_FETCH, enabled: true });
    expect(spec?.parameters).not.toHaveProperty('max_content_tokens');
  });

  /*
   * An empty allow list means "no restriction", and sending it as an empty
   * array invites the opposite reading.
   */
  it('omits both domain lists when they are empty', () => {
    const spec = hostedFetchSpec({ ...DEFAULT_AGENT_HOSTED_FETCH, enabled: true });
    expect(spec?.parameters).not.toHaveProperty('allowed_domains');
    expect(spec?.parameters).not.toHaveProperty('blocked_domains');
  });

  it('sends the domain lists when they hold anything', () => {
    const spec = hostedFetchSpec({
      ...DEFAULT_AGENT_HOSTED_FETCH,
      enabled: true,
      allowedDomains: ['docs.example.com'],
      blockedDomains: ['ads.example.com'],
      maxContentTokens: 4_000
    });
    expect(spec?.parameters?.allowed_domains).toEqual(['docs.example.com']);
    expect(spec?.parameters?.blocked_domains).toEqual(['ads.example.com']);
    expect(spec?.parameters?.max_content_tokens).toBe(4_000);
  });
});

describe('parseHostedFetchResult', () => {
  it('is null for a payload that is not one', () => {
    expect(parseHostedFetchResult('not json')).toBeNull();
    expect(parseHostedFetchResult('{"foo":1}')).toBeNull();
  });

  it('reads a page that arrived', () => {
    const result = parseHostedFetchResult(
      JSON.stringify({
        url: 'https://example.com/a',
        title: 'A',
        content: 'body',
        status: 'completed',
        retrieved_at: '2026-07-15T14:30:00.000Z'
      })
    );
    expect(result).toEqual({
      status: 'completed',
      url: 'https://example.com/a',
      title: 'A',
      content: 'body'
    });
  });

  it('reads a fetch that failed, which arrives as a result rather than an error', () => {
    const result = parseHostedFetchResult(
      JSON.stringify({ url: 'https://example.com/a', status: 'failed', error: '404' })
    );
    expect(result).toEqual({ status: 'failed', url: 'https://example.com/a', error: '404' });
  });

  /*
   * Anything that is not the one documented success word is a failure. A status
   * this build has not seen is not a page to draw as though it had arrived.
   */
  it('treats an unrecognised status as a failure', () => {
    const result = parseHostedFetchResult(
      JSON.stringify({ url: 'https://example.com/a', status: 'pending', content: 'half' })
    );
    expect(result?.status).toBe('failed');
  });

  it('tolerates a page with no title', () => {
    const result = parseHostedFetchResult(
      JSON.stringify({ url: 'https://example.com/a', content: 'body', status: 'completed' })
    );
    expect(result).toEqual({
      status: 'completed',
      url: 'https://example.com/a',
      title: null,
      content: 'body'
    });
  });
});
