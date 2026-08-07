import { describe, it, expect, vi } from 'vitest';
import { sanitizeSummary, generateSummary, resolveSummary } from '../pane-summarizer';
import type { completeOnce } from '../agent/openrouter';

/** A stand-in for `completeOnce` that answers with the given text. */
function answering(text: string): typeof completeOnce {
  return vi.fn(() => Promise.resolve({ text, usage: null }));
}

/** A stand-in for `completeOnce` that fails the way a rate-limited call does. */
function failing(message: string): typeof completeOnce {
  return vi.fn(() => Promise.reject(new Error(message)));
}

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
    const summary = await generateSummary(answering('"needs input: proceed with deploy?"'), {
      apiKey: 'k',
      model: 'cheap/model',
      tailText: '> Proceed with deploy? (y/n)'
    });
    expect(summary).toBe('needs input: proceed with deploy?');
  });
});

describe('resolveSummary (never throws)', () => {
  it('returns the model summary when available', async () => {
    const summary = await resolveSummary(answering('Editing CollisionSystem.ts'), {
      apiKey: 'k',
      model: 'm',
      tailText: 'diff --git a/CollisionSystem.ts'
    });
    expect(summary).toBe('Editing CollisionSystem.ts');
  });

  it('returns empty string when the model throws', async () => {
    const summary = await resolveSummary(failing('rate limited'), {
      apiKey: 'k',
      model: 'm',
      tailText: 'output'
    });
    expect(summary).toBe('');
  });
});
