import { describe, it, expect } from 'vitest';
import { PiBedrockInjectionSchema, PiEnvInjectionSchema } from '../../shared/pi-env-injection-types';

describe('PiBedrockInjectionSchema', () => {
  it('defaults mode to "chain"', () => {
    const parsed = PiBedrockInjectionSchema.parse({});
    expect(parsed.mode).toBe('chain');
  });

  it('accepts all three modes', () => {
    for (const mode of ['profile', 'keys', 'chain'] as const) {
      expect(PiBedrockInjectionSchema.parse({ mode }).mode).toBe(mode);
    }
  });

  it('preserves unknown sibling keys via passthrough', () => {
    const parsed = PiEnvInjectionSchema.parse({
      bedrock: { mode: 'profile', profile: 'dev' },
      futureProvider: { apiKey: 'x' }
    });
    expect(parsed).toMatchObject({ futureProvider: { apiKey: 'x' } });
  });
});
