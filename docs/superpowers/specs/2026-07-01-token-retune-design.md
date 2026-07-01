# Design: Re-tune Fleet UI design tokens (#398)

## Context

Issue #398 is Tier 1 of the Fleet UI modernization epic (#410).
The epic's headline finding is that Fleet's theming architecture is already good (semantic `--fleet-*` tokens, 14 presets, an app-chrome color-derivation function) but the token *values* are generic.
This spec covers de-genericizing those values: a cool-gray tint, hairline borders, a sharper radius scale, and a reserved signature overlay shadow.

It follows #397 (migrate hardcoded `neutral-*` classes to `fleet-*` tokens, PR #446), which established that most of the app already consumes the semantic tokens - this issue changes what those tokens resolve to.

## Current architecture (relevant parts)

- `src/renderer/src/index.css` defines the `:root` CSS custom properties (`--fleet-bg`, `--fleet-surface`, `--fleet-surface-2/3`, `--fleet-border`, `--fleet-border-strong`, `--fleet-text*`, `--radius`) and a Tailwind `@theme inline` block that exposes them as `fleet-*` utility classes.
- `src/shared/theme-presets.ts` defines 14 `TerminalThemeDefinition` entries.
  Each has a `background`/`foreground`/`kind` (dark or light) and an optional `appOverrides: Partial<AppThemeTokens>`.
  Only `fleet-dark` and `fleet-light` (the two flagship themes) provide full manual `appOverrides` for the app-chrome token set.
  The other 12 themes have no overrides and get their app-chrome tokens entirely from derivation.
- `src/renderer/src/lib/theme.ts` has `deriveAppTheme(def)`, which computes the app-chrome token set from a theme's `background`/`foreground` using `mixHex` (linear sRGB channel blending), then layers `def.appOverrides` on top.
  This single function is why "apply across all 14 presets" is mostly a one-function change rather than 14 separate edits.

## Changes

### 1. Cool-gray tint (fleet-dark & fleet-light only)

The two flagship themes' `appOverrides` currently use flat Tailwind `neutral-*` hex values (zero chroma - "dead gray").
Retint `bg`, `surface`, `surface2`, `surface3`, `text`, `textSecondary`, `textMuted`, `textSubtle` to OKLCH hue 260, chroma 0.006, preserving each value's original lightness.

Computed via a one-off OKLab conversion script (Björn Ottosson's sRGB↔OKLab matrices), values below.
WCAG contrast ratios were checked before/after and shift by at most 0.15 (e.g. fleet-light text/bg: 16.63 → 16.58) - imperceptible, no regression.

**fleet-dark:**

| token | old | new |
|---|---|---|
| bg | `#0a0a0a` | `#090a0d` |
| surface | `#171717` | `#15171a` |
| surface2 | `#262626` | `#242629` |
| surface3 | `#404040` | `#3e4043` |
| text | `#fafafa` | `#f8fafe` |
| textSecondary | `#d4d4d4` | `#d2d4d8` |
| textMuted | `#a3a3a3` | `#a1a3a7` |
| textSubtle | `#737373` | `#717377` |

**fleet-light:**

| token | old | new |
|---|---|---|
| bg | `#f5f7fa` | `#f5f7fb` |
| surface | `#ffffff` | `#fdffff` |
| surface2 | `#eef2f7` | `#eff2f6` |
| surface3 | `#e2e8f0` | `#e5e8eb` |
| text | `#0f172a` | `#16181b` |
| textSecondary | `#334155` | `#3e4043` |
| textMuted | `#64748b` | `#717376` |
| textSubtle | `#94a3b8` | `#9fa2a5` |

The other 12 themes are not touched - they derive color from their own terminal palette, which is already chromatic.

### 2. Elevation ladder

No algorithm change.
`deriveAppTheme`'s existing `mixHex(bg, fg, 0.05 / 0.10 / 0.16)` progression for `surface` / `surface2` / `surface3` already produces lightness-based depth, which is what the issue asks for.
Rewriting it to perceptual OKLCH mixing across all 12 derived themes would be a materially bigger, riskier change than this issue calls for, so it's out of scope here.
"Formalize" is interpreted as: keep `bg` → `surface` → `surface-2` → `surface-3` as the official 4-step ladder (no rename to `card`/`popover` - the existing names stay, since renaming is a larger app-wide find/replace with no functional benefit).

### 3. Hairline borders

Replace `deriveAppTheme`'s opaque mixed-hex `border` / `borderStrong` with translucent overlays that work on any surface underneath:

```js
border: dark ? 'oklch(1 0 0 / 0.08)' : 'oklch(0 0 0 / 0.08)',
borderStrong: dark ? 'oklch(1 0 0 / 0.16)' : 'oklch(0 0 0 / 0.16)',
```

This applies universally across all 14 themes through the one shared function.
`fleet-dark` and `fleet-light`'s `appOverrides` currently hardcode `border`/`borderStrong` - those two keys are deleted from both override objects so they fall through to the new universal formula, which is the mechanism that makes this "apply across all 14 presets" cheap.

Electron 39 bundles a Chromium recent enough for native `oklch()` support (Tailwind v4's own default palette already relies on it), so no fallback is needed.

### 4. Radius

Change the base `--radius` from `0.5rem` (8px) to `0.375rem` (6px).
Add a new `@theme` block (separate from the existing `@theme inline` block, since radius isn't per-theme/runtime-switched) defining the standard shadcn-style derived scale:

```css
@theme {
  --radius-sm: calc(var(--radius) - 4px); /* 2px */
  --radius-md: calc(var(--radius) - 2px); /* 4px */
  --radius-lg: var(--radius);             /* 6px */
  --radius-xl: calc(var(--radius) + 4px); /* 10px */
}
```

Tailwind v4's default radius scale (`--radius-sm: 4px`, `--radius-md: 6px`, `--radius-lg: 8px`, `--radius-xl: 12px`) is currently disconnected from `--radius` entirely - `--radius` is dead/unused today.
Wiring it up this way retroactively resharpens every existing `rounded-sm`/`md`/`lg`/`xl` utility class app-wide (roughly 90+ usages across the codebase) with a single CSS change - no component files are touched.
`--radius-2xl`/`3xl`/`4xl` and `rounded-full` are untouched (not mentioned in the issue, low usage, no need to touch).

### 5. Signature overlay shadow

Add one new token:

```css
--fleet-shadow-overlay: 0 20px 60px -12px rgba(0, 0, 0, 0.5), 0 8px 24px -8px rgba(0, 0, 0, 0.35);
```

exposed as a `.fleet-shadow-overlay { box-shadow: var(--fleet-shadow-overlay); }` utility class, applied as the default box-shadow on the shared `Overlay.tsx` panel div.

This is intentionally scoped narrowly: `Overlay.tsx` is the one shared modal/overlay primitive (16 current consumers), so this establishes the token and the "one signature shadow" pattern without a broader sweep.
Most existing `Overlay` consumers already pass their own `shadow-lg`/`xl`/`2xl` class via `panelClassName`, which will keep winning in the cascade for those call sites - this change doesn't visually alter existing modals yet, it only makes the pattern available and used by default for any panel that doesn't specify its own shadow.
Migrating the ~36 files that currently set ad hoc `shadow-*` classes to this token is out of scope for this PR (comparable to leaving `CrtFrame.tsx` out of #397) - filing a fast-follow issue is recommended.

## Out of scope

- Rewriting `mixHex`/derivation math to OKLCH (see "Elevation ladder" above).
- Renaming `surface`/`surface-2`/`surface-3` tokens to `card`/`popover`.
- Sweeping existing per-component `shadow-*` classes to the new signature-shadow token.
- Any of the other #410 sub-issues (#399 font, #400 motion, Tier 2/3 items).

## Verification

- The OKLCH-conversion + WCAG-contrast script (already run during design) confirms no meaningful contrast regression for the retinted fleet-dark/fleet-light tokens.
- `npm run typecheck && npm run lint`.
- Manually launch the dev build and visually check a few presets (at least one dark, one light) for the new radius/border/tint, plus confirm nothing looks broken.
