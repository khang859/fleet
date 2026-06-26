import { describe, it, expect, vi } from 'vitest';
import { sanitizeTitle, fallbackTitle, generateTitle, resolveTitle } from '../chat-namer';
import { OpenRouterClient } from '../openrouter-client';

describe('sanitizeTitle', () => {
  it('strips quotes, markdown, and trailing punctuation', () => {
    expect(sanitizeTitle('"Fix login bug."')).toBe('Fix login bug');
    expect(sanitizeTitle('**Deploy pipeline**')).toBe('Deploy pipeline');
    expect(sanitizeTitle('`git rebase help`')).toBe('git rebase help');
  });
  it('caps at 5 words and collapses whitespace', () => {
    expect(sanitizeTitle('one two three four five six seven')).toBe('one two three four five');
    expect(sanitizeTitle('  spaced   out   title  ')).toBe('spaced out title');
  });
  it('returns empty string when nothing usable remains', () => {
    expect(sanitizeTitle('   ')).toBe('');
    expect(sanitizeTitle('"""')).toBe('');
  });
});

describe('fallbackTitle', () => {
  it('uses the first line keywords', () => {
    expect(fallbackTitle('How do I configure webpack?\nmore detail')).toBe(
      'How do I configure webpack?'
    );
  });
  it('truncates very long first lines', () => {
    const long = 'supercalifragilistic '.repeat(10);
    expect(fallbackTitle(long).endsWith('…')).toBe(true);
  });
  it('falls back to a dated placeholder when there is no text', () => {
    expect(fallbackTitle('   ', Date.UTC(2026, 0, 15))).toBe('Chat — 2026-01-15');
  });
});

describe('generateTitle', () => {
  it('sanitizes the model output', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockResolvedValue('"Webpack Config Help."');
    const title = await generateTitle(client, {
      apiKey: 'k',
      model: 'cheap/model',
      firstUser: 'how do I configure webpack',
      firstAssistant: 'You can use...'
    });
    expect(title).toBe('Webpack Config Help');
  });
});

describe('resolveTitle (fallback cascade)', () => {
  it('returns the model title when available', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockResolvedValue('Deploy Script');
    const title = await resolveTitle(client, {
      apiKey: 'k',
      model: 'm',
      firstUser: 'help with deploy',
      firstAssistant: 'sure'
    });
    expect(title).toBe('Deploy Script');
  });

  it('falls back to keyword extraction when the model throws', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockRejectedValue(new Error('rate limited'));
    const title = await resolveTitle(client, {
      apiKey: 'k',
      model: 'm',
      firstUser: 'Reset my database password',
      firstAssistant: ''
    });
    expect(title).toBe('Reset my database password');
  });

  it('falls back to keywords when the model returns an empty title', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockResolvedValue('  ');
    const title = await resolveTitle(client, {
      apiKey: 'k',
      model: 'm',
      firstUser: 'Explain monads briefly',
      firstAssistant: 'ok'
    });
    expect(title).toBe('Explain monads briefly');
  });
});
