import { describe, expect, it } from 'vitest';
import { formatCost, formatPrice, formatTokens } from '../format';

describe('formatPrice', () => {
  it('shows cents with two digits, and whole dollars without, the same for both', () => {
    expect(formatPrice({ input: 0.3, output: 1.2 })).toBe('$0.30 / $1.20');
    expect(formatPrice({ input: 3, output: 15 })).toBe('$3 / $15');
    expect(formatPrice({ input: 0, output: 2.5 })).toBe('$0.00 / $2.50');
    expect(formatPrice({ input: 0.3, output: 1 })).toBe('$0.30 / $1.00');
  });

  it('is the price per million tokens in formatCost', () => {
    expect(formatCost({ input: 3, output: 15 })).toBe('$3 / $15 per 1M');
  });
});

describe('formatTokens', () => {
  it('drops a place after the point that is 0', () => {
    expect(formatTokens(1_048_576)).toBe('1M');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(262_144)).toBe('262k');
  });
});
