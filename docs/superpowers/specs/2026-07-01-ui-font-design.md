# Design: Add a real UI font + tabular figures (#399)

## Context

Issue #399 is Tier 1 of the Fleet UI modernization epic (#410).
Fleet's app chrome currently has no explicit `font-family`, so it falls back to Tailwind's default sans stack (`ui-sans-serif, system-ui, ...`), which the epic calls "the bare system font stack."
This issue bundles a real UI sans font and applies tabular figures to the app's live-updating numeric displays.

It follows #397 (neutral -> fleet token migration, PR #446) and #398 (cool-gray tint, hairline borders, sharper radius, PR #447).
Per the epic's own coordination note, #398 and #399 both touch `index.css`; #398 has already merged, so this work lands cleanly on top.

## Current state (relevant parts)

- `src/renderer/src/index.css` has no `font-family` declared on `html`/`body`/`#root` - Tailwind v4's Preflight fills this in from a `--font-sans` theme variable (confirmed in `node_modules/tailwindcss/preflight.css` and `theme.css`: `html { font-family: --theme(--default-font-family, ...) }`, where `--default-font-family` resolves from `--font-sans`).
- The only fonts currently bundled are Nerd Fonts for the terminal: `JetBrains Mono Nerd Font` (4 static weight/style `.ttf` files) and `Symbols Nerd Font` (1 file), self-hosted via hand-written `@font-face` rules in `index.css`, with `LICENSE`/`OFL.txt` committed alongside in `src/renderer/src/assets/fonts/`.
- Tailwind's `font-mono` utility is used pervasively across ~30 component files (code inputs, JSON editors, secrets forms) but is NOT wired to the bundled Nerd Font - it resolves to Tailwind's own default mono stack. This is a pre-existing gap, unrelated to this issue, called out below as explicitly out of scope.
- No numeric UI display currently applies tabular figures. Two live-updating numeric spots exist: `TabItem.tsx`'s elapsed-time counter (`mm:ss`, recomputed on each render while a pane has been quiet for 10s+) and cost figures rendered via `SessionList.tsx` / `usage-format.ts` (`toFixed(2)`-formatted dollar amounts).
- No exit-code display exists anywhere in the renderer today, so that example from the issue's body does not apply.

## Changes

### 1. Bundle Inter as a self-hosted variable font

Vendor 4 static files from the `@fontsource-variable/inter` npm package (v5.2.8, OFL-1.1 licensed) into `src/renderer/src/assets/fonts/`:

- `inter-latin-wght-normal.woff2` (47.1K)
- `inter-latin-wght-italic.woff2` (50.6K)
- `inter-latin-ext-wght-normal.woff2` (83.1K)
- `inter-latin-ext-wght-italic.woff2` (89.7K)

Total ~270K, versus JetBrains Mono Nerd Font's ~9.6MB across 4 files (Nerd Font glyph patching bloats file size; Inter has no such patching).
These 4 files are the *variable* font (weight axis 100-900 in one file each), not per-weight static files - covers every Tailwind `font-*` weight utility (`font-normal` through `font-black`) without extra files.

Only `latin` + `latin-ext` subsets are vendored (not Google Fonts' full cyrillic/greek/vietnamese subset split).
That splitting exists to minimize download size for *web* delivery over the network; Fleet is a bundled Electron app loading fonts from local disk, so there is no download-size benefit and no reason to carry the extra subsets or the unicode-range-based `@font-face` fragmentation that goes with them.

This is a one-time vendor operation (`npm pack @fontsource-variable/inter`, extract, copy 4 files + `OFL.txt`) - **no npm runtime dependency is added to `package.json`**, matching the existing convention where the bundled Nerd Fonts are checked-in binaries with a license file, not an installed package.

Add `@font-face` rules to `src/renderer/src/index.css`, immediately after the existing Nerd Font block:

```css
/* Inter (self-hosted variable font, weight axis 100-900).
   unicode-range values are copied verbatim from @fontsource-variable/inter's
   own generated CSS, not invented - they define which codepoints each file
   covers so the browser loads the right one per glyph. */
@font-face {
  font-family: 'Inter';
  src: url('./assets/fonts/inter-latin-wght-normal.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329,
    U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'Inter';
  src: url('./assets/fonts/inter-latin-ext-wght-normal.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329,
    U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Inter';
  src: url('./assets/fonts/inter-latin-wght-italic.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: italic;
  font-display: swap;
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329,
    U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'Inter';
  src: url('./assets/fonts/inter-latin-ext-wght-italic.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: italic;
  font-display: swap;
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329,
    U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
```

Both `latin` and `latin-ext` carry their real `unicode-range` (copied from the package's own CSS, not the placeholder/invented range from an earlier draft of this spec) so the browser matches each glyph to the correct file - neither file is "unrestricted."
`format('woff2-variations')` is the correct format string for a variable woff2 font; Electron 39's bundled Chromium supports it natively.

### 2. Wire Inter as the default UI sans font

Add a new `@theme` block in `index.css` (same non-`inline` block introduced by #398 for radius, since font tokens are static, not per-theme):

```css
@theme {
  --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
}
```

Because Tailwind v4's Preflight derives `html`'s default `font-family` from `--font-sans`, this single override makes Inter the default everywhere in the app in one change - no per-component edits needed.
Anything already using the `font-mono` utility or an explicit terminal `font-family` is unaffected, since sans and mono are independent theme axes.

### 3. Tabular figures utility + two call sites

Add a small utility class near the existing `.fleet-shadow-overlay`/`.fleet-accent-*` utilities in `index.css`:

```css
.fleet-tnum {
  font-variant-numeric: tabular-nums slashed-zero;
}
```

`tabular-nums` fixes digit width so a ticking counter doesn't reflow; `slashed-zero` (Inter supports the OpenType `zero` feature) disambiguates `0` from `O` in dense numeric UI.
This is the modern CSS equivalent of the issue's suggested `font-feature-settings: 'tnum' 1, 'zero' 1` - `font-variant-numeric` is the standard property for this and browsers translate it to the same OpenType features.

Apply `fleet-tnum` at exactly two places:

- `src/renderer/src/components/TabItem.tsx` - the elapsed-time `<span>` (the `mm:ss` counter computed from `lastOutputAt`).
- Cost-figure output in `src/renderer/src/components/sessions/SessionList.tsx` and `src/renderer/src/components/chat/usage-format.ts` - wherever the `toFixed(2)`-formatted dollar string is rendered.

No other numeric UI is touched - the issue's own "exit codes" example doesn't apply (no such display exists), and a broader sweep for every incidental number in the app is out of scope for this ticket, same scoping discipline as #397/#398.

## Out of scope

- **Root `font-size`/line-height tightening** ("13-14px body, line-height ~1.1-1.2 for dense rows" from the issue body). The codebase already uses Tailwind's `text-xs`/`text-sm` (12-14px) with `leading-tight`/`leading-none` throughout dense UI (`TabItem.tsx`, `PaneHeader.tsx`, etc.) - there's no unstyled 16px body text to fix. The only way to force a literal 13px document base would be `html { font-size: 13px }`, but Tailwind's spacing scale is also rem-based off that same root, so it would shrink padding/margins/icon sizing app-wide too - a much larger, riskier change than this ticket's "mostly mechanical" framing implies, for no visible gain over what's already there.
- **`--font-display`** - the issue calls this optional. There's no headline/marketing text anywhere in this dense tool UI that would benefit from a distinct display font, so it's skipped rather than added speculatively.
- **Wiring `--font-mono` to the bundled JetBrains Mono Nerd Font.** Noticed while investigating: Tailwind's `font-mono` utility (used in ~30 files for code/JSON/secrets inputs) currently resolves to Tailwind's default mono stack, not the Nerd Font that's already bundled and used directly by the terminal/xterm surfaces. This is a real, pre-existing gap, but it's unrelated to adding a UI sans font - flagged here as a fast-follow candidate, not fixed in this PR.
- Any other #410 sub-issue (#400 motion, Tier 2/3 items).

## Verification

- UI chrome renders in Inter (visually confirm at least one dark and one light theme, per the same manual-check pattern as #397/#398).
- The `TabItem.tsx` elapsed timer and cost figures visually hold fixed digit width as they update/vary.
- `npm run typecheck && npm run lint`.
- `npm test` - no regressions.
