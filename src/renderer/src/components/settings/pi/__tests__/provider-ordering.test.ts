import { describe, it, expect } from 'vitest';
import { orderProviderRows, type ProviderRowInput } from '../lib/provider-ordering';

const row = (
  id: string,
  kind: ProviderRowInput['kind'],
  configured: boolean
): ProviderRowInput => ({
  id,
  label: id,
  kind,
  configured
});

describe('orderProviderRows', () => {
  it('puts configured rows (built-in and custom) alphabetically in the primary tier', () => {
    const out = orderProviderRows([
      row('zeta-custom', 'custom', true),
      row('anthropic', 'oauth-builtin', true),
      row('bedrock', 'managed-builtin', false),
      row('ollama', 'env-builtin-readonly', false)
    ]);
    expect(out.primary.map((r) => r.id)).toEqual(['anthropic', 'bedrock', 'ollama', 'zeta-custom']);
  });

  it('adds primary unconfigured built-ins after configured rows, alphabetical', () => {
    const out = orderProviderRows([
      row('anthropic', 'oauth-builtin', true),
      row('bedrock', 'managed-builtin', false),
      row('ollama', 'env-builtin-readonly', false),
      row('openai', 'oauth-builtin', false),
      row('google', 'oauth-builtin', false),
      row('openrouter', 'env-builtin-readonly', false)
    ]);
    expect(out.primary.map((r) => r.id)).toEqual([
      'anthropic',
      'bedrock',
      'google',
      'ollama',
      'openai',
      'openrouter'
    ]);
  });

  it('collects secondary built-ins into `secondary` (hidden behind Show more)', () => {
    const out = orderProviderRows([
      row('azure', 'env-builtin-readonly', false),
      row('mistral', 'env-builtin-readonly', false),
      row('xai', 'env-builtin-readonly', false),
      row('anthropic', 'oauth-builtin', true)
    ]);
    expect(out.primary.map((r) => r.id)).toEqual(['anthropic']);
    expect(out.secondary.map((r) => r.id)).toEqual(['azure', 'mistral', 'xai']);
  });

  it('a configured secondary built-in is promoted into primary', () => {
    const out = orderProviderRows([
      row('azure', 'env-builtin-readonly', true),
      row('anthropic', 'oauth-builtin', true)
    ]);
    expect(out.primary.map((r) => r.id)).toEqual(['anthropic', 'azure']);
    expect(out.secondary).toEqual([]);
  });
});
