import { describe, it, expect, vi } from 'vitest';
import { sanitizeTags, generateTags, resolveTags } from '../chat-tagger';
import { OpenRouterClient } from '../openrouter-client';

describe('sanitizeTags', () => {
  it('splits, lowercases, and trims a comma list', () => {
    expect(sanitizeTags('Webpack, Build Config, CI')).toEqual(['webpack', 'build config', 'ci']);
  });
  it('strips leading # and surrounding markdown/quotes', () => {
    expect(sanitizeTags('#react, "hooks", **state**')).toEqual(['react', 'hooks', 'state']);
  });
  it('dedupes and caps at three tags', () => {
    expect(sanitizeTags('a, a, b, c, d, e')).toEqual(['a', 'b', 'c']);
  });
  it('drops empty and over-long tags', () => {
    const long = 'x'.repeat(40);
    expect(sanitizeTags(`, ok, ${long}`)).toEqual(['ok']);
  });
  it('handles newline-separated output', () => {
    expect(sanitizeTags('one\ntwo\nthree')).toEqual(['one', 'two', 'three']);
  });
});

describe('generateTags', () => {
  it('sanitizes the model output', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockResolvedValue('Webpack, Build Config');
    const tags = await generateTags(client, {
      apiKey: 'k',
      model: 'cheap/model',
      firstUser: 'how do I configure webpack',
      firstAssistant: 'You can use...'
    });
    expect(tags).toEqual(['webpack', 'build config']);
  });
});

describe('resolveTags', () => {
  it('returns tags when the model responds', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockResolvedValue('deploy, ci');
    const tags = await resolveTags(client, {
      apiKey: 'k',
      model: 'm',
      firstUser: 'help with deploy',
      firstAssistant: 'sure'
    });
    expect(tags).toEqual(['deploy', 'ci']);
  });

  it('returns [] when the model throws', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockRejectedValue(new Error('rate limited'));
    const tags = await resolveTags(client, {
      apiKey: 'k',
      model: 'm',
      firstUser: 'anything',
      firstAssistant: ''
    });
    expect(tags).toEqual([]);
  });
});
