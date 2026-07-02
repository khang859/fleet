import { describe, expect, it } from 'vitest';
import {
  deriveAppTheme,
  resolveAccentColor,
  resolveTerminalTheme,
  resolveXtermTheme
} from '../theme';
import { TERMINAL_THEMES } from '../../../../shared/theme-presets';
import { contrastRatio } from '../contrast';

describe('theme resolvers', () => {
  it('falls back to the default terminal theme for unknown ids', () => {
    expect(resolveTerminalTheme('unknown' as never).id).toBe('fleet-dark');
    expect(resolveTerminalTheme(undefined).id).toBe('fleet-dark');
  });

  it('returns a fresh xterm theme object with a derived inactive-selection color', () => {
    const resolved = resolveXtermTheme('fleet-dark');
    expect(resolved).toEqual({
      ...TERMINAL_THEMES['fleet-dark'].xterm,
      selectionInactiveBackground: resolved.selectionInactiveBackground
    });
    expect(resolved.selectionInactiveBackground).toMatch(/^#[0-9a-f]{6}$/i);
    expect(resolved).not.toBe(TERMINAL_THEMES['fleet-dark'].xterm);
  });

  it('dims selectionInactiveBackground toward the pane background, not toward the selection color', () => {
    const resolved = resolveXtermTheme('fleet-dark');
    const { background, selectionBackground, selectionInactiveBackground } = resolved;
    expect(selectionInactiveBackground).not.toBe(selectionBackground);
    expect(selectionInactiveBackground).not.toBe(background);
  });

  it('computes selectionInactiveBackground from the opaque background, not the transparent override', () => {
    const resolved = resolveXtermTheme('fleet-dark', true);
    expect(resolved.background).toBe('rgba(0, 0, 0, 0)');
    expect(resolved.selectionInactiveBackground).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('falls back to the default accent color for unknown ids', () => {
    expect(resolveAccentColor('unknown' as never).id).toBe('blue');
    expect(resolveAccentColor(undefined).id).toBe('blue');
  });
});

describe('deriveAppTheme borders', () => {
  it('derives a translucent white hairline border for dark themes with no override', () => {
    const t = deriveAppTheme(TERMINAL_THEMES['dracula']);
    expect(t.border).toBe('oklch(1 0 0 / 0.08)');
    expect(t.borderStrong).toBe('oklch(1 0 0 / 0.16)');
  });

  it('derives a translucent black hairline border for light themes with no override', () => {
    const t = deriveAppTheme(TERMINAL_THEMES['catppuccin-latte']);
    expect(t.border).toBe('oklch(0 0 0 / 0.08)');
    expect(t.borderStrong).toBe('oklch(0 0 0 / 0.16)');
  });

  it('applies the universal border formula to fleet-dark and fleet-light too (no per-theme override)', () => {
    const dark = deriveAppTheme(TERMINAL_THEMES['fleet-dark']);
    const light = deriveAppTheme(TERMINAL_THEMES['fleet-light']);
    expect(dark.border).toBe('oklch(1 0 0 / 0.08)');
    expect(dark.borderStrong).toBe('oklch(1 0 0 / 0.16)');
    expect(light.border).toBe('oklch(0 0 0 / 0.08)');
    expect(light.borderStrong).toBe('oklch(0 0 0 / 0.16)');
  });
});

describe('fleet-dark / fleet-light cool-gray retint', () => {
  it('retints fleet-dark neutrals to OKLCH hue 260 chroma 0.006 at the same lightness', () => {
    const t = deriveAppTheme(TERMINAL_THEMES['fleet-dark']);
    expect(t.bg).toBe('#090a0d');
    expect(t.surface).toBe('#15171a');
    expect(t.surface2).toBe('#242629');
    expect(t.surface3).toBe('#3e4043');
    expect(t.text).toBe('#f8fafe');
    expect(t.textSecondary).toBe('#d2d4d8');
    expect(t.textMuted).toBe('#a1a3a7');
    expect(t.textSubtle).toBe('#717377');
  });

  it('retints fleet-light neutrals to OKLCH hue 260 chroma 0.006 at the same lightness', () => {
    const t = deriveAppTheme(TERMINAL_THEMES['fleet-light']);
    expect(t.bg).toBe('#f5f7fb');
    expect(t.surface).toBe('#fdffff');
    expect(t.surface2).toBe('#eff2f6');
    expect(t.surface3).toBe('#e5e8eb');
    expect(t.text).toBe('#16181b');
    expect(t.textSecondary).toBe('#3e4043');
    expect(t.textMuted).toBe('#717376');
    expect(t.textSubtle).toBe('#9fa2a5');
  });

  it('does not regress WCAG contrast for fleet-dark after retinting', () => {
    const t = deriveAppTheme(TERMINAL_THEMES['fleet-dark']);
    expect(contrastRatio(t.text, t.bg)).toBeCloseTo(18.94, 1);
    expect(contrastRatio(t.text, t.surface)).toBeCloseTo(17.19, 1);
    expect(contrastRatio(t.textSecondary, t.bg)).toBeCloseTo(13.34, 1);
    expect(contrastRatio(t.textMuted, t.bg)).toBeCloseTo(7.84, 1);
    expect(contrastRatio(t.textSubtle, t.bg)).toBeCloseTo(4.17, 1);
  });

  it('does not regress WCAG contrast for fleet-light after retinting', () => {
    const t = deriveAppTheme(TERMINAL_THEMES['fleet-light']);
    expect(contrastRatio(t.text, t.bg)).toBeCloseTo(16.58, 1);
    expect(contrastRatio(t.text, t.surface)).toBeCloseTo(17.72, 1);
    expect(contrastRatio(t.textSecondary, t.bg)).toBeCloseTo(9.7, 1);
    expect(contrastRatio(t.textMuted, t.bg)).toBeCloseTo(4.43, 1);
    expect(contrastRatio(t.textSubtle, t.bg)).toBeCloseTo(2.39, 1);
  });
});
