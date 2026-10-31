import { describe, expect, it, vi } from 'vitest';
import type { AgentToolContext, AgentUrlFetcher } from '../../../../shared/agent-tools';
import { runWebFetch } from '../web-fetch';

/**
 * The tool, as distinct from the pipeline behind it.
 *
 * Everything about addresses and HTML is tested next door in `web/__tests__`.
 * What is left here is the seam: that a switched-off capability produces a
 * sentence the model can act on rather than a crash, and that the row says
 * something useful about what came back.
 */

const ctx = (fetchUrl: AgentUrlFetcher | null): AgentToolContext => ({
  cwd: '/tmp/nowhere',
  threadId: '11111111-2222-4333-8444-555555555555',
  signal: new AbortController().signal,
  handOff: () => {},
  approve: async () => Promise.resolve(true),
  wasRefused: () => false,
  generateImage: null,
  fetchUrl,
  mcp: null,
  dispatchTask: null,
  findSubagent: null,
  findSkill: null,
  findMemory: null,
  schedule: null,
  todos: { list: () => [], save: () => {} }
});

describe('web_fetch', () => {
  it('returns what the capability gave it', async () => {
    const result = await runWebFetch(
      { url: 'https://example.com' },
      ctx(async () => Promise.resolve('# Title\n\nsome words about a widget'))
    );

    expect(result.text).toContain('some words about a widget');
  });

  it('passes the turn’s signal through, so stopping stops the fetch', async () => {
    const controller = new AbortController();
    const fetchUrl = vi.fn<AgentUrlFetcher>(async () => Promise.resolve('ok'));
    const base = ctx(fetchUrl);

    await runWebFetch({ url: 'https://example.com' }, { ...base, signal: controller.signal });

    expect(fetchUrl).toHaveBeenCalledWith('https://example.com', controller.signal);
  });

  it('tells the model where the switch is when reading pages is off', async () => {
    await expect(runWebFetch({ url: 'https://example.com' }, ctx(null))).rejects.toThrow(
      /agent settings/
    );
  });

  it('lets a refusal from below through as the failure it is', async () => {
    const refuse: AgentUrlFetcher = async () =>
      Promise.reject(
        new Error('Refused to fetch 169.254.169.254: that is a cloud metadata address')
      );

    await expect(runWebFetch({ url: 'http://169.254.169.254' }, ctx(refuse))).rejects.toThrow(
      /metadata/
    );
  });

  it('counts the page in words, which is what a collapsed row is for', async () => {
    const words = async (n: number): Promise<string> =>
      (
        await runWebFetch(
          { url: 'https://x.com' },
          ctx(async () => Promise.resolve('w '.repeat(n)))
        )
      ).summary;

    expect(await words(12)).toBe('12 words');
    expect(await words(2500)).toBe('2.5k words');
    expect(await words(0)).toBe('nothing');
  });
});
