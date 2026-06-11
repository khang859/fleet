/**
 * WCAG contrast math + legibility hints for terminal background images.
 *
 * Pure functions — no React, no DOM, no imports.
 */

/**
 * Parse a hex color ('#rrggbb' or '#rgb', with or without '#') to [r,g,b] 0-255.
 * Returns null on invalid input.
 */
export function hexToRgb(hex: string): [number, number, number] | null {
  const s = hex.startsWith('#') ? hex.slice(1) : hex;
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return [r, g, b];
  }
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return [r, g, b];
  }
  return null;
}

/**
 * WCAG relative luminance (0..1) for a hex color. Returns 0 if unparseable.
 */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => {
    const lin = c / 255;
    return lin <= 0.03928 ? lin / 12.92 : ((lin + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio (1..21) between two hex colors. Returns 1 if either is unparseable.
 */
export function contrastRatio(a: string, b: string): number {
  if (!hexToRgb(a) || !hexToRgb(b)) return 1;
  const lumA = relativeLuminance(a);
  const lumB = relativeLuminance(b);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Heuristic legibility hint for an IMAGE background behind terminal text.
 *
 * Returns a short user-facing message when the image is likely to hurt readability,
 * or null when it's fine.
 *
 * Logic:
 * - Warn when opacity > 0.5 AND blur < 4 (unknown image pixels increasingly replace
 *   the safe theme bg, worst-case contrast can collapse toward ~1).
 * - Use a stronger message when opacity > 0.75.
 * - If the theme's own base contrast < 4.5, mention it.
 */
export function backgroundLegibilityHint(opts: {
  opacity: number;
  blur: number;
  themeForeground: string;
  themeBackground: string;
}): string | null {
  const { opacity, blur, themeForeground, themeBackground } = opts;
  const base = contrastRatio(themeForeground, themeBackground);
  const lowThemeContrast = base < 4.5;
  const lowThemeMsg = 'This terminal theme already has low text contrast.';

  if (opacity > 0.75 && blur < 4) {
    const msg =
      'High image opacity may make terminal text hard to read — lower opacity or add blur.';
    return lowThemeContrast ? `${msg} ${lowThemeMsg}` : msg;
  }

  if (opacity > 0.5 && blur < 4) {
    const msg = 'Image opacity is moderate — consider lowering it or adding blur for readability.';
    return lowThemeContrast ? `${msg} ${lowThemeMsg}` : msg;
  }

  if (lowThemeContrast) {
    return lowThemeMsg;
  }

  return null;
}
