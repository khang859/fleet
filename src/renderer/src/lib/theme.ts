import type { CSSProperties } from 'react';

type FleetAccentCssProperties = CSSProperties & {
  '--fleet-accent': string;
  '--fleet-accent-hover': string;
};
import {
  ACCENT_COLORS,
  DEFAULT_ACCENT_COLOR_ID,
  DEFAULT_TERMINAL_THEME_ID,
  TERMINAL_THEMES,
  isAccentColorId,
  isTerminalThemeId,
  type AccentColorDefinition,
  type AccentColorId,
  type TerminalThemeDefinition,
  type TerminalThemeId,
  type TerminalThemeColors
} from '../../../shared/theme-presets';

export function resolveTerminalTheme(id?: string): TerminalThemeDefinition {
  if (id && isTerminalThemeId(id)) {
    return TERMINAL_THEMES[id];
  }
  return TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_ID];
}

export function resolveXtermTheme(id?: TerminalThemeId): TerminalThemeColors {
  return { ...resolveTerminalTheme(id).xterm };
}

export function resolveAccentColor(id?: string): AccentColorDefinition {
  if (id && isAccentColorId(id)) {
    return ACCENT_COLORS[id];
  }
  return ACCENT_COLORS[DEFAULT_ACCENT_COLOR_ID];
}

export function getAccentCssVars(id?: AccentColorId): FleetAccentCssProperties {
  const accent = resolveAccentColor(id);
  return {
    '--fleet-accent': accent.value,
    '--fleet-accent-hover': accent.hover
  };
}
