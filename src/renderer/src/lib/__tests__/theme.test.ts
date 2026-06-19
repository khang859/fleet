import { describe, expect, it } from 'vitest';
import { resolveAccentColor, resolveTerminalTheme, resolveXtermTheme } from '../theme';
import { TERMINAL_THEMES } from '../../../../shared/theme-presets';

describe('theme resolvers', () => {
  it('falls back to the default terminal theme for unknown ids', () => {
    expect(resolveTerminalTheme('unknown' as never).id).toBe('fleet-dark');
    expect(resolveTerminalTheme(undefined).id).toBe('fleet-dark');
  });

  it('returns a fresh xterm theme object', () => {
    const resolved = resolveXtermTheme('fleet-dark');
    expect(resolved).toEqual(TERMINAL_THEMES['fleet-dark'].xterm);
    expect(resolved).not.toBe(TERMINAL_THEMES['fleet-dark'].xterm);
  });

  it('falls back to the default accent color for unknown ids', () => {
    expect(resolveAccentColor('unknown' as never).id).toBe('blue');
    expect(resolveAccentColor(undefined).id).toBe('blue');
  });
});
