import { describe, expect, it } from 'vitest';
import { backgroundLegibilityHint, contrastRatio, hexToRgb, relativeLuminance } from '../contrast';

describe('hexToRgb', () => {
  it('parses 6-digit hex with hash', () => {
    expect(hexToRgb('#ff0000')).toEqual([255, 0, 0]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255]);
  });

  it('parses 3-digit hex with hash (expands correctly)', () => {
    expect(hexToRgb('#f00')).toEqual([255, 0, 0]);
    expect(hexToRgb('#abc')).toEqual([170, 187, 204]);
  });

  it('parses hex without leading hash', () => {
    expect(hexToRgb('ff0000')).toEqual([255, 0, 0]);
    expect(hexToRgb('abc')).toEqual([170, 187, 204]);
  });

  it('returns null for invalid input', () => {
    expect(hexToRgb('')).toBeNull();
    expect(hexToRgb('#gg0000')).toBeNull();
    expect(hexToRgb('#12345')).toBeNull();
    expect(hexToRgb('not-a-color')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('returns 0 for black', () => {
    expect(relativeLuminance('#000000')).toBe(0);
  });

  it('returns 1 for white', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('returns a value in 0..1 range', () => {
    const val = relativeLuminance('#4a90d9');
    expect(val).toBeGreaterThan(0);
    expect(val).toBeLessThan(1);
  });

  it('returns 0 for unparseable input', () => {
    expect(relativeLuminance('not-valid')).toBe(0);
  });
});

describe('contrastRatio', () => {
  it('black vs white is ~21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('white vs white is 1:1', () => {
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
  });

  it('black vs black is 1:1', () => {
    expect(contrastRatio('#000000', '#000000')).toBe(1);
  });

  it('is symmetric (a vs b equals b vs a)', () => {
    const ab = contrastRatio('#1a2b3c', '#e0d0c0');
    const ba = contrastRatio('#e0d0c0', '#1a2b3c');
    expect(ab).toBeCloseTo(ba, 10);
  });

  it('returns 1 for unparseable input', () => {
    expect(contrastRatio('not-a-color', '#ffffff')).toBe(1);
    expect(contrastRatio('#ffffff', 'not-a-color')).toBe(1);
  });
});

describe('backgroundLegibilityHint', () => {
  const goodTheme = { themeForeground: '#ffffff', themeBackground: '#000000' };
  // Low-contrast theme: luminance diff is small
  const badTheme = { themeForeground: '#888888', themeBackground: '#999999' };

  it('returns null at low opacity (no risk)', () => {
    expect(backgroundLegibilityHint({ opacity: 0.15, blur: 0, ...goodTheme })).toBeNull();
    expect(backgroundLegibilityHint({ opacity: 0.5, blur: 0, ...goodTheme })).toBeNull();
  });

  it('returns null when blur is sufficient (≥4), even at high opacity', () => {
    expect(backgroundLegibilityHint({ opacity: 0.9, blur: 4, ...goodTheme })).toBeNull();
    expect(backgroundLegibilityHint({ opacity: 0.8, blur: 10, ...goodTheme })).toBeNull();
  });

  it('returns a message at opacity 0.8 / blur 0 (strong warning)', () => {
    const result = backgroundLegibilityHint({ opacity: 0.8, blur: 0, ...goodTheme });
    expect(result).not.toBeNull();
    expect(result).toContain('High image opacity');
  });

  it('returns a milder message in the 0.5–0.75 opacity band (blur 0)', () => {
    const result = backgroundLegibilityHint({ opacity: 0.6, blur: 0, ...goodTheme });
    expect(result).not.toBeNull();
    expect(result).not.toContain('High image opacity');
    expect(result).toContain('moderate');
  });

  it('includes low-contrast theme warning in strong message', () => {
    const result = backgroundLegibilityHint({ opacity: 0.8, blur: 0, ...badTheme });
    expect(result).not.toBeNull();
    expect(result).toContain('High image opacity');
    expect(result).toContain('low text contrast');
  });

  it('includes low-contrast theme warning in moderate message', () => {
    const result = backgroundLegibilityHint({ opacity: 0.6, blur: 0, ...badTheme });
    expect(result).not.toBeNull();
    expect(result).toContain('low text contrast');
  });

  it('warns about low theme contrast alone when opacity is safe', () => {
    const result = backgroundLegibilityHint({ opacity: 0.2, blur: 0, ...badTheme });
    expect(result).not.toBeNull();
    expect(result).toContain('low text contrast');
  });
});
