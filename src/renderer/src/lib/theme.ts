import type { CSSProperties } from 'react';

type FleetThemeCssProperties = CSSProperties & Record<`--fleet-${string}`, string>;
import {
  ACCENT_COLORS,
  DEFAULT_ACCENT_COLOR_ID,
  DEFAULT_APP_THEME,
  DEFAULT_TERMINAL_THEME_ID,
  TERMINAL_THEMES,
  isAccentColorId,
  isAppThemeSelection,
  isTerminalThemeId,
  type AccentColorDefinition,
  type AccentColorId,
  type AppThemeSelection,
  type AppThemeTokens,
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

export function getAccentCssVars(id?: AccentColorId): FleetThemeCssProperties {
  const accent = resolveAccentColor(id);
  return {
    '--fleet-accent': accent.value,
    '--fleet-accent-hover': accent.hover
  };
}

// ── App theme (UI chrome) ──────────────────────────────────────────────────

function parseHex(hex: string): [number, number, number] {
  // padEnd guards against a malformed/short hex producing NaN channels.
  const h = hex.replace('#', '').padEnd(6, '0');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Linearly blend two hex colors. `t=0` returns `a`, `t=1` returns `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const ch = (x: number, y: number): string =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/**
 * Build the app-chrome token set from a theme's base colors, then layer in any
 * per-theme `appOverrides`. Surfaces/borders contrast against the background by
 * mixing toward the foreground; text mutes by mixing toward the background.
 */
export function deriveAppTheme(def: TerminalThemeDefinition): AppThemeTokens {
  const dark = def.kind === 'dark';
  const fg = def.xterm.foreground ?? (dark ? '#e4e4e4' : '#1f2937');
  // App shell sits a touch darker than the terminal pane so panes stay distinct.
  const bg = dark
    ? mixHex(def.background, '#000000', 0.25)
    : mixHex(def.background, '#000000', 0.02);
  const derived: AppThemeTokens = {
    bg,
    surface: mixHex(bg, fg, 0.05),
    surface2: mixHex(bg, fg, 0.1),
    surface3: mixHex(bg, fg, 0.16),
    border: mixHex(bg, fg, 0.14),
    borderStrong: mixHex(bg, fg, 0.24),
    text: fg,
    textSecondary: mixHex(fg, bg, 0.18),
    textMuted: mixHex(fg, bg, 0.4),
    textSubtle: mixHex(fg, bg, 0.55)
  };
  return { ...derived, ...def.appOverrides };
}

/** Map a legacy or arbitrary stored value to a valid selection. */
export function normalizeAppTheme(value?: string): AppThemeSelection {
  if (!value) return DEFAULT_APP_THEME;
  if (value === 'dark') return 'fleet-dark';
  if (value === 'light') return 'fleet-light';
  if (isAppThemeSelection(value)) return value;
  return DEFAULT_APP_THEME;
}

/** Resolve a selection (incl. system / match-terminal) to a concrete theme. */
export function resolveAppThemeDefinition(
  selection: string | undefined,
  terminalTheme: string | undefined,
  prefersDark: boolean
): TerminalThemeDefinition {
  const sel = normalizeAppTheme(selection);
  if (sel === 'system') {
    return resolveTerminalTheme(prefersDark ? 'fleet-dark' : 'fleet-light');
  }
  if (sel === 'match-terminal') {
    return resolveTerminalTheme(terminalTheme);
  }
  return resolveTerminalTheme(sel);
}

export function getAppThemeCssVars(def: TerminalThemeDefinition): FleetThemeCssProperties {
  const t = deriveAppTheme(def);
  return {
    '--fleet-bg': t.bg,
    '--fleet-surface': t.surface,
    '--fleet-surface-2': t.surface2,
    '--fleet-surface-3': t.surface3,
    '--fleet-border': t.border,
    '--fleet-border-strong': t.borderStrong,
    '--fleet-text': t.text,
    '--fleet-text-secondary': t.textSecondary,
    '--fleet-text-muted': t.textMuted,
    '--fleet-text-subtle': t.textSubtle
  };
}
