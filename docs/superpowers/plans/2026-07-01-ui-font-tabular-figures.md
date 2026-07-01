# UI Font + Tabular Figures (#399) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle Inter as Fleet's self-hosted default UI sans font, and apply tabular figures to the app's two live-updating numeric displays, per issue #399, spec at `docs/superpowers/specs/2026-07-01-ui-font-design.md`.

**Architecture:** Font files are vendored (not an npm runtime dependency) into `src/renderer/src/assets/fonts/`, alongside the existing self-hosted Nerd Fonts. A single `--font-sans` override in `index.css`'s existing static `@theme` block makes Inter the default everywhere, because Tailwind v4's Preflight derives `html`'s font-family from that variable. A new `.fleet-tnum` utility class is applied at exactly two JSX call sites that render live-updating digits.

**Tech Stack:** TypeScript, React, Tailwind CSS v4 (`@theme`, `@font-face`), self-hosted `woff2-variations` font files.

## Global Constraints

- No npm runtime dependency is added to `package.json` for the font - files are vendored once from `@fontsource-variable/inter@5.2.8` and committed as binaries, matching the existing JetBrains Mono Nerd Font convention.
- Only `latin` and `latin-ext` subsets are vendored (4 files total: normal/italic x latin/latin-ext), each with its exact `unicode-range` copied verbatim from the source package's own CSS - never invent or approximate a `unicode-range`.
- `--font-sans` must be set in a static (non-`inline`) `@theme` block, since it does not vary per active theme preset - it goes in the same block Task 4 of the #398 plan created for `--radius-sm/md/lg/xl`.
- The `.fleet-tnum` utility applies `font-variant-numeric: tabular-nums slashed-zero;` (the modern CSS equivalent of `font-feature-settings: 'tnum' 1, 'zero' 1'`) and is applied at exactly two call sites: `TabItem.tsx`'s freshness span, and every span in `SessionList.tsx`/`UsageMeter.tsx` that renders a cost or token figure. No other numeric UI in the app is touched.
- `npm run typecheck && npm run lint` must pass after every task that touches `.ts`/`.tsx` files.

---

### Task 1: Vendor Inter and wire it as the default UI sans font

**Files:**
- Create: `src/renderer/src/assets/fonts/inter-latin-wght-normal.woff2`
- Create: `src/renderer/src/assets/fonts/inter-latin-ext-wght-normal.woff2`
- Create: `src/renderer/src/assets/fonts/inter-latin-wght-italic.woff2`
- Create: `src/renderer/src/assets/fonts/inter-latin-ext-wght-italic.woff2`
- Create: `src/renderer/src/assets/fonts/Inter-OFL.txt`
- Modify: `src/renderer/src/index.css:56-61` (existing static `@theme` block from #398) and `src/renderer/src/index.css:102` (end of the "Bundled Nerd Fonts" section)

**Interfaces:**
- Consumes: nothing new.
- Produces: the CSS custom font family `'Inter'`, and Tailwind's `--font-sans` theme variable now resolving to it. Task 2 does not depend on this task's output (it only touches unrelated CSS/JSX), but both land in the same PR.

- [ ] **Step 1: Fetch and extract the font files**

Run these exact commands from the repo root:

```bash
cd /tmp && npm pack @fontsource-variable/inter@5.2.8 --silent
mkdir -p /tmp/inter-extract
tar -xzf /tmp/fontsource-variable-inter-5.2.8.tgz -C /tmp/inter-extract
cd -
```

Expected: `/tmp/inter-extract/package/files/` contains (among many other subset files you will not use) `inter-latin-wght-normal.woff2`, `inter-latin-ext-wght-normal.woff2`, `inter-latin-wght-italic.woff2`, `inter-latin-ext-wght-italic.woff2`, and `/tmp/inter-extract/package/LICENSE` exists.

- [ ] **Step 2: Copy the 4 font files and the license into the repo**

```bash
cp /tmp/inter-extract/package/files/inter-latin-wght-normal.woff2 src/renderer/src/assets/fonts/
cp /tmp/inter-extract/package/files/inter-latin-ext-wght-normal.woff2 src/renderer/src/assets/fonts/
cp /tmp/inter-extract/package/files/inter-latin-wght-italic.woff2 src/renderer/src/assets/fonts/
cp /tmp/inter-extract/package/files/inter-latin-ext-wght-italic.woff2 src/renderer/src/assets/fonts/
cp /tmp/inter-extract/package/LICENSE src/renderer/src/assets/fonts/Inter-OFL.txt
```

Expected: `ls src/renderer/src/assets/fonts/` now shows the 4 new `.woff2` files (total ~270K) plus `Inter-OFL.txt`, alongside the existing JetBrains Mono / Symbols Nerd Font files and their own `LICENSE`/`OFL.txt` (do not touch or rename those - they belong to a different font family and are unrelated to this change).

- [ ] **Step 3: Add the `@font-face` rules**

In `src/renderer/src/index.css`, immediately after the closing `}` of the "Symbols Nerd Font Mono" `@font-face` block (currently ending at line 102, right before the blank line and `:root {` on line 104), insert:

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

- [ ] **Step 4: Set `--font-sans` as the default**

In `src/renderer/src/index.css`, find the static `@theme` block (currently lines 54-61):

```css
/* Sharper "tool, not marketing" radius scale, derived from a single knob.
   --radius itself is static (not per-theme), so this doesn't need `inline`. */
@theme {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
```

Replace it with (adds `--font-sans`, updates the comment to reflect both static concerns now living in this block):

```css
/* Static (non-per-theme) design tokens - font family and the radius scale
   derived from a single knob - so neither needs `inline`. */
@theme {
  --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
```

Because Tailwind v4's Preflight sets `html`'s font-family from `--font-sans` (`node_modules/tailwindcss/preflight.css` reads `--default-font-family`, which `node_modules/tailwindcss/theme.css` derives from `--font-sans`), this single change makes Inter the default everywhere in the app that isn't already using `font-mono` or an explicit terminal font.

- [ ] **Step 5: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors (CSS-only + new binary asset files, this confirms nothing else broke).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/assets/fonts/inter-latin-wght-normal.woff2 \
        src/renderer/src/assets/fonts/inter-latin-ext-wght-normal.woff2 \
        src/renderer/src/assets/fonts/inter-latin-wght-italic.woff2 \
        src/renderer/src/assets/fonts/inter-latin-ext-wght-italic.woff2 \
        src/renderer/src/assets/fonts/Inter-OFL.txt \
        src/renderer/src/index.css
git commit -m "feat(theme): bundle Inter and set it as the default UI font (#399)"
```

---

### Task 2: Add tabular figures at the two live-updating numeric call sites

**Files:**
- Modify: `src/renderer/src/index.css` (add `.fleet-tnum` utility)
- Modify: `src/renderer/src/components/TabItem.tsx:288-291`
- Modify: `src/renderer/src/components/sessions/SessionList.tsx:113-114`
- Modify: `src/renderer/src/components/chat/UsageMeter.tsx:6-13` and `:17-38`

**Interfaces:**
- Consumes: nothing new.
- Produces: the `.fleet-tnum` CSS class, applied at all 4 JSX locations below.

- [ ] **Step 1: Add the `.fleet-tnum` utility class**

In `src/renderer/src/index.css`, immediately after the `.fleet-shadow-overlay` rule (currently lines 190-192):

```css
.fleet-shadow-overlay {
  box-shadow: var(--fleet-shadow-overlay);
}
```

add:

```css

.fleet-tnum {
  font-variant-numeric: tabular-nums slashed-zero;
}
```

- [ ] **Step 2: Apply it to `TabItem.tsx`'s freshness span**

`formatFreshness` (around line 74-86) returns strings like `"5m ago"`, `"30s ago"`, or `"5m waiting"` - the digit count varies as the value grows past 9, causing the span to reflow. Find (around line 288-291):

```tsx
                ) : freshness ? (
                  <span className={activity?.state === 'needs_me' ? 'text-amber-400' : ''}>
                    {freshness}
                  </span>
                ) : (
```

Replace with:

```tsx
                ) : freshness ? (
                  <span
                    className={`fleet-tnum ${activity?.state === 'needs_me' ? 'text-amber-400' : ''}`}
                  >
                    {freshness}
                  </span>
                ) : (
```

- [ ] **Step 3: Apply it to `SessionList.tsx`'s cost span**

Find (around line 113-114):

```tsx
                        <span
                          className="ml-auto flex-shrink-0 font-mono text-fleet-text"
```

Replace with:

```tsx
                        <span
                          className="ml-auto flex-shrink-0 font-mono fleet-tnum text-fleet-text"
```

- [ ] **Step 4: Apply it to `UsageMeter.tsx`'s two rendering sites**

Find (around line 13):

```tsx
  return <span className="text-[10px] text-fleet-text-muted">{parts.join(' · ')}</span>;
```

Replace with:

```tsx
  return <span className="fleet-tnum text-[10px] text-fleet-text-muted">{parts.join(' · ')}</span>;
```

Find (around line 28-32):

```tsx
    <div
      className={`flex items-center justify-end gap-2 border-t border-fleet-border px-3 py-1 text-[11px] ${
        over ? 'text-amber-400' : 'text-fleet-text-muted'
      }`}
    >
```

Replace with:

```tsx
    <div
      className={`fleet-tnum flex items-center justify-end gap-2 border-t border-fleet-border px-3 py-1 text-[11px] ${
        over ? 'text-amber-400' : 'text-fleet-text-muted'
      }`}
    >
```

- [ ] **Step 5: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/index.css \
        src/renderer/src/components/TabItem.tsx \
        src/renderer/src/components/sessions/SessionList.tsx \
        src/renderer/src/components/chat/UsageMeter.tsx
git commit -m "feat(ui): apply tabular figures to elapsed-time and cost displays (#399)"
```

---

### Task 3: Full verification pass

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions in any other test file (this feature has no new automated tests - font/CSS rendering and JSX className additions aren't unit-tested elsewhere in this codebase either, e.g. #398's radius/shadow/Overlay.tsx changes had none).

- [ ] **Step 2: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual visual check**

Launch the dev build (`npm run dev`), or ask the user to look at their already-running instance. Check:
- UI chrome (sidebar, tab bar, settings panels, buttons) renders in Inter, not the previous system sans - most noticeable on longer text like settings labels.
- Terminal panes and anything using `font-mono` (JSON/secrets inputs) are unaffected - still monospace.
- In a session/tab that has been idle 10+ seconds, the freshness label in the tab (e.g. "12s ago") and, if a Claude session has a cost estimate, the cost figure in the Sessions list render with even digit spacing (tabular figures) - compare visually to a non-tabular number elsewhere to confirm the difference is present, however subtle.
- No layout regressions anywhere chrome text got wider/narrower from the font swap (check a few dense rows: tab bar, pane header, sidebar list).

- [ ] **Step 4: Report results to the user**

Summarize what was verified and ask for confirmation before opening the PR.

---

## Self-Review Notes

- **Spec coverage:** all 3 changes from the spec have a task - bundling + wiring Inter (Task 1), tabular figures utility + both approved call sites (Task 2), verification (Task 3). The spec's "out of scope" items (root font-size, `--font-display`, `--font-mono` wiring) have no corresponding task, correctly.
- **Placeholder scan:** none found - every step has literal code/commands, including exact `unicode-range` values copied from the real package (verified against `/tmp/fontsource-extract/package/wght.css` and `wght-italic.css` during planning, not invented).
- **Type consistency:** no new TypeScript types or function signatures are introduced by this plan - it's CSS + JSX className edits only, so there's no cross-task signature to keep consistent.
- **Scope check discovered during planning:** the spec named "SessionList.tsx / usage-format.ts" as the second tabular-figures site, but `usage-format.ts`'s `formatUsd`/`formatTokens` are pure string formatters with no JSX of their own - the actual render sites are `SessionList.tsx` (its own local `formatCost` helper, separate from `usage-format.ts`) and `UsageMeter.tsx` (which imports `usage-format.ts`). Task 2 targets the real three JSX locations across these two component files rather than the spec's file list literally, since `usage-format.ts` itself has no template to modify.
