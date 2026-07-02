import { describe, it, expect, vi } from 'vitest';
import { sanitizeSummary, generateSummary, resolveSummary } from '../pane-summarizer';
import { OpenRouterClient } from '../openrouter-client';

describe('sanitizeSummary', () => {
  it('strips quotes, markdown, and a trailing period', () => {
    expect(sanitizeSummary('"Editing CollisionSystem.ts."')).toBe('Editing CollisionSystem.ts');
    expect(sanitizeSummary('**needs input: double jump?**')).toBe('needs input: double jump?');
  });
  it('collapses whitespace', () => {
    expect(sanitizeSummary('  running   tests  ')).toBe('running tests');
  });
  it('truncates overly long output with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const result = sanitizeSummary(long);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(80);
  });
  it('returns empty string when nothing usable remains', () => {
    expect(sanitizeSummary('   ')).toBe('');
    expect(sanitizeSummary('"""')).toBe('');
  });
});

describe('generateSummary', () => {
  it('sanitizes the model output', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockResolvedValue('"needs input: proceed with deploy?"');
    const summary = await generateSummary(client, {
      apiKey: 'k',
      model: 'cheap/model',
      tailText: '> Proceed with deploy? (y/n)'
    });
    expect(summary).toBe('needs input: proceed with deploy?');
  });
});

describe('resolveSummary (never throws)', () => {
  it('returns the model summary when available', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockResolvedValue('Editing CollisionSystem.ts');
    const summary = await resolveSummary(client, {
      apiKey: 'k',
      model: 'm',
      tailText: 'diff --git a/CollisionSystem.ts'
    });
    expect(summary).toBe('Editing CollisionSystem.ts');
  });

  it('returns empty string when the model throws', async () => {
    const client = new OpenRouterClient();
    vi.spyOn(client, 'complete').mockRejectedValue(new Error('rate limited'));
    const summary = await resolveSummary(client, { apiKey: 'k', model: 'm', tailText: 'output' });
    expect(summary).toBe('');
  });
});
