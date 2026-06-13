import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BUNDLED_PRICES,
  priceTableSchema,
  resolvePrice,
  estimateCostUsd,
  estimateSessionCostUsd,
  type ClaudeUsageInput,
  type PriceTable
} from '../claude-pricing';

const zeroUsage: ClaudeUsageInput = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0
};

describe('resolvePrice', () => {
  it('matches an exact known family prefix', () => {
    expect(resolvePrice('claude-opus-4-8', BUNDLED_PRICES)?.input).toBe(5);
    expect(resolvePrice('claude-fable-5', BUNDLED_PRICES)?.input).toBe(10);
    expect(resolvePrice('claude-sonnet-4-6', BUNDLED_PRICES)?.input).toBe(3);
    expect(resolvePrice('claude-haiku-4-5', BUNDLED_PRICES)?.input).toBe(1);
  });

  it('matches a future point release within a family via prefix', () => {
    expect(resolvePrice('claude-opus-4-99', BUNDLED_PRICES)?.input).toBe(5);
  });

  it('prefers the longest matching prefix', () => {
    // mythos and fable both $10/$50 but resolve via their own prefixes
    expect(resolvePrice('claude-mythos-5', BUNDLED_PRICES)?.output).toBe(50);
  });

  it('returns undefined for an unknown model', () => {
    expect(resolvePrice('gpt-4o', BUNDLED_PRICES)).toBeUndefined();
    expect(resolvePrice('claude-opus-3', BUNDLED_PRICES)).toBeUndefined();
  });

  it('uses the longer prefix when two prefixes both match', () => {
    const table: PriceTable = {
      schemaVersion: 1,
      updated: '2026-06-12',
      models: [
        {
          prefix: 'claude-opus-4-',
          input: 5,
          output: 25,
          cacheReadMult: 0.1,
          cacheWrite5mMult: 1.25,
          cacheWrite1hMult: 2
        },
        {
          prefix: 'claude-opus-4-fast-',
          input: 10,
          output: 50,
          cacheReadMult: 0.1,
          cacheWrite5mMult: 1.25,
          cacheWrite1hMult: 2
        }
      ]
    };
    expect(resolvePrice('claude-opus-4-fast-1', table)?.input).toBe(10);
    expect(resolvePrice('claude-opus-4-8', table)?.input).toBe(5);
  });
});

describe('estimateCostUsd', () => {
  it('computes cost from tokens × rates with cache multipliers', () => {
    // opus-4-8: input $5/MTok, output $25/MTok, cacheRead 0.1×, write5m 1.25×, write1h 2×
    const cost = estimateCostUsd(
      {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000
      },
      'claude-opus-4-8',
      BUNDLED_PRICES
    );
    // 5 + 25 + (5*0.1) + (5*1.25) + (5*2) = 5 + 25 + 0.5 + 6.25 + 10 = 46.75
    expect(cost).toBeCloseTo(46.75, 5);
  });

  it('returns undefined for an unpriced model', () => {
    expect(estimateCostUsd(zeroUsage, 'mystery-model', BUNDLED_PRICES)).toBeUndefined();
  });
});

describe('estimateSessionCostUsd', () => {
  it('sums cost across models', () => {
    const perModel = new Map<string, ClaudeUsageInput>([
      ['claude-opus-4-8', { ...zeroUsage, output: 1_000_000 }], // $25
      ['claude-haiku-4-5', { ...zeroUsage, output: 1_000_000 }] // $5
    ]);
    expect(estimateSessionCostUsd(perModel, BUNDLED_PRICES)).toBeCloseTo(30, 5);
  });

  it('returns undefined if any model is unpriced', () => {
    const perModel = new Map<string, ClaudeUsageInput>([
      ['claude-opus-4-8', { ...zeroUsage, output: 1_000_000 }],
      ['mystery-model', { ...zeroUsage, output: 1_000_000 }]
    ]);
    expect(estimateSessionCostUsd(perModel, BUNDLED_PRICES)).toBeUndefined();
  });

  it('returns undefined for an empty usage map', () => {
    expect(estimateSessionCostUsd(new Map(), BUNDLED_PRICES)).toBeUndefined();
  });
});

describe('bundled table', () => {
  it('passes its own schema', () => {
    expect(priceTableSchema.safeParse(BUNDLED_PRICES).success).toBe(true);
  });

  it('stays in sync with resources/claude-pricing.json', () => {
    const json = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../resources/claude-pricing.json', import.meta.url)),
        'utf8'
      )
    );
    expect(json).toEqual(BUNDLED_PRICES);
  });
});
