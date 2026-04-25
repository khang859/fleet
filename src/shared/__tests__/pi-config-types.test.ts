import { describe, it, expect } from 'vitest';
import {
  PiSettingsSchema,
  PiModelsFileSchema,
  parseApiKeyString,
  serializeApiKey
} from '../pi-config-types';

describe('PiSettingsSchema', () => {
  it('parses minimal object', () => {
    const out = PiSettingsSchema.parse({});
    expect(out).toEqual({});
  });

  it('preserves unknown fields via passthrough', () => {
    const input = {
      defaultProvider: 'anthropic',
      compaction: { enabled: true, reserveTokens: 16384 },
      customField: 'preserved'
    };
    const out = PiSettingsSchema.parse(input);
    expect(out).toMatchObject(input);
  });

  it('rejects invalid thinking level', () => {
    expect(() => PiSettingsSchema.parse({ defaultThinkingLevel: 'extreme' })).toThrow();
  });
});

describe('PiModelsFileSchema', () => {
  it('defaults providers to empty object', () => {
    const out = PiModelsFileSchema.parse({});
    expect(out.providers).toEqual({});
  });

  it('preserves unknown provider fields', () => {
    const input = {
      providers: {
        ollama: {
          baseUrl: 'http://localhost:11434/v1',
          api: 'openai-completions' as const,
          unknownField: 42,
          models: [{ id: 'llama3.1:8b', extra: 'keep' }]
        }
      }
    };
    const out = PiModelsFileSchema.parse(input);
    expect(out.providers.ollama).toMatchObject({ unknownField: 42 });
    expect(out.providers.ollama.models?.[0]).toMatchObject({ extra: 'keep' });
  });

  it('accepts Pi API identifiers Fleet does not explicitly model', () => {
    const out = PiModelsFileSchema.parse({
      providers: {
        bedrock: { api: 'bedrock-converse-stream' },
        mistral: { api: 'mistral-conversations' },
        future: { api: 'future-api-added-by-pi' }
      }
    });

    expect(out.providers.bedrock.api).toBe('bedrock-converse-stream');
    expect(out.providers.mistral.api).toBe('mistral-conversations');
    expect(out.providers.future.api).toBe('future-api-added-by-pi');
  });
});

describe('parseApiKeyString', () => {
  it('detects shell command by leading !', () => {
    expect(parseApiKeyString('!security find-generic-password -ws anthropic')).toEqual({
      kind: 'shell',
      command: 'security find-generic-password -ws anthropic'
    });
  });

  it('detects env var from SCREAMING_SNAKE_CASE', () => {
    expect(parseApiKeyString('ANTHROPIC_API_KEY')).toEqual({
      kind: 'envVar',
      name: 'ANTHROPIC_API_KEY'
    });
  });

  it('treats literal-looking values as literal', () => {
    expect(parseApiKeyString('sk-ant-abc123')).toEqual({ kind: 'literal', value: 'sk-ant-abc123' });
  });

  it('treats empty/undefined as undefined', () => {
    expect(parseApiKeyString(undefined)).toBeUndefined();
    expect(parseApiKeyString('')).toBeUndefined();
  });
});

describe('serializeApiKey', () => {
  it('serializes shell with leading !', () => {
    expect(serializeApiKey({ kind: 'shell', command: 'op read foo' })).toBe('!op read foo');
  });

  it('serializes envVar as name', () => {
    expect(serializeApiKey({ kind: 'envVar', name: 'MY_KEY' })).toBe('MY_KEY');
  });

  it('serializes literal as value', () => {
    expect(serializeApiKey({ kind: 'literal', value: 'sk-123' })).toBe('sk-123');
  });
});
