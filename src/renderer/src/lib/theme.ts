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

export function resolveXtermTheme(
  id?: TerminalThemeId,
  transparentBackground = false
): TerminalThemeColors {
  const theme = { ...resolveTerminalTheme(id).xterm };
  // Dim the selection toward the pane background so an unfocused pane's
  // selection reads as "not live" (xterm swaps to this automatically when the
  // terminal's DOM element blurs). Computed here rather than authored per
  // theme so all 14 presets stay consistent.
  if (theme.selectionBackground && theme.background) {
    theme.selectionInactiveBackground = mixHex(theme.selectionBackground, theme.background, 0.6);
  }
  // When a terminal background image is active, render xterm's default cell
  // background transparently so the image layer behind it shows through.
  if (transparentBackground) {
    theme.background = 'rgba(0, 0, 0, 0)';
  }
  return theme;
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

/**
 * The surface tokens a pane's chrome paints with once there is a background
 * image behind it: the same colors, mixed toward transparent so the picture
 * reads through them. Returns nothing when no image is showing, which leaves
 * the `index.css` defaults - the opaque tokens - in place.
 *
 * Surfaces opt in by name (`bg-fleet-glass-surface`), so the things that must
 * stay solid to stay usable - text inputs, the settings cards - simply keep
 * asking for the opaque token and are unaffected.
 */
export function getGlassCssVars(active: boolean): FleetThemeCssProperties | undefined {
  if (!active) return undefined;
  // Held above the pane's own background opacity: chrome is what the user
  // reads and types into, so it stays the most solid thing over the picture.
  const glass = (token: string, percent: number): string =>
    `color-mix(in srgb, var(${token}) ${percent}%, transparent)`;
  return {
    '--fleet-glass-bg': glass('--fleet-bg', 55),
    '--fleet-glass-surface': glass('--fleet-surface', 70),
    '--fleet-glass-surface-2': glass('--fleet-surface-2', 65),
    '--fleet-glass-surface-3': glass('--fleet-surface-3', 70)
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
  // Translucent hairline borders (Raycast/Linear-style): a white or black
  // overlay at low alpha reads correctly against any surface underneath,
  // so this is universal across all 14 themes rather than per-theme mixed hex.
  const borderOverlay = dark ? '1 0 0' : '0 0 0';
  const derived: AppThemeTokens = {
    bg,
    surface: mixHex(bg, fg, 0.05),
    surface2: mixHex(bg, fg, 0.1),
    surface3: mixHex(bg, fg, 0.16),
    border: `oklch(${borderOverlay} / 0.08)`,
    borderStrong: `oklch(${borderOverlay} / 0.16)`,
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
