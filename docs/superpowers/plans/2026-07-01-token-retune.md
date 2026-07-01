# Token Re-tune (#398) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-genericize Fleet's app-chrome design tokens (cool-gray tint, hairline borders, sharper radius scale, one signature overlay shadow) per issue #398, spec at `docs/superpowers/specs/2026-07-01-token-retune-design.md`.

**Architecture:** Almost all of the color/border work lands in two files - `src/shared/theme-presets.ts` (the two flagship themes' `appOverrides`) and `src/renderer/src/lib/theme.ts` (the shared `deriveAppTheme` function used by all 14 themes) - because the app-chrome token pipeline already funnels every theme through one derivation function. Radius and the shadow token are pure CSS changes in `src/renderer/src/index.css`.

**Tech Stack:** TypeScript, Vitest, Tailwind CSS v4 (`@theme` blocks), CSS `oklch()` color function (native in Electron 39's bundled Chromium).

## Global Constraints

- Retinted hex values must preserve each token's original OKLCH lightness (only hue/chroma change) - see spec table for exact old→new values.
- Border/borderStrong become theme-invariant translucent overlays (`oklch(1 0 0 / 0.08)` dark, `oklch(0 0 0 / 0.08)` light) computed once in `deriveAppTheme`, not per-theme.
- `--radius` base becomes `0.375rem` (6px); derived scale via `calc(var(--radius) ± Npx)` exactly as specified in the spec.
- No changes to `mixHex`/surface derivation algorithm, no token renames, no sweep of existing per-component `shadow-*` classes - all explicitly out of scope per the spec.
- `npm run typecheck && npm run lint` must pass after every task that touches `.ts`/`.tsx` files.

---

### Task 1: Write failing tests for the new border/borderStrong derivation and retinted tokens

**Files:**
- Modify: `src/renderer/src/lib/__tests__/theme.test.ts`

**Interfaces:**
- Consumes: `deriveAppTheme` from `../theme` (existing export, signature unchanged: `(def: TerminalThemeDefinition) => AppThemeTokens`), `TERMINAL_THEMES` from `../../../../shared/theme-presets` (existing export), `contrastRatio` from `../contrast` (existing export, signature `(a: string, b: string) => number`).
- Produces: nothing consumed by later tasks - this is the test file that Tasks 2-3 must satisfy.

- [ ] **Step 1: Add the new test cases**

First, update the existing import block at the top of `src/renderer/src/lib/__tests__/theme.test.ts`. Replace:

```ts
import { describe, expect, it } from 'vitest';
import { resolveAccentColor, resolveTerminalTheme, resolveXtermTheme } from '../theme';
import { TERMINAL_THEMES } from '../../../../shared/theme-presets';
```

with:

```ts
import { describe, expect, it } from 'vitest';
import { deriveAppTheme, resolveAccentColor, resolveTerminalTheme, resolveXtermTheme } from '../theme';
import { TERMINAL_THEMES } from '../../../../shared/theme-presets';
import { contrastRatio } from '../contrast';
```

Then add this to the bottom of the file (keep the existing `describe('theme resolvers', ...)` block untouched, add these two new `describe` blocks after it):

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/renderer/src/lib/__tests__/theme.test.ts`
Expected: FAIL - the `deriveAppTheme borders` and `fleet-dark / fleet-light cool-gray retint` tests fail because the current implementation still returns the old opaque hex borders and old flat-gray hex values.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/__tests__/theme.test.ts
git commit -m "test(theme): add failing specs for token re-tune (#398)"
```

---

### Task 2: Implement the universal translucent hairline border in `deriveAppTheme`

**Files:**
- Modify: `src/renderer/src/lib/theme.ts:81-101` (the `deriveAppTheme` function)

**Interfaces:**
- Consumes: nothing new.
- Produces: `deriveAppTheme` now returns `border`/`borderStrong` as `oklch()` strings instead of `mixHex(...)` results. `AppThemeTokens.border`/`.borderStrong` remain typed `string` (no type change - `oklch(...)` is a valid CSS color string).

- [ ] **Step 1: Replace the border/borderStrong computation**

In `src/renderer/src/lib/theme.ts`, replace:

```ts
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
```

with:

```ts
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
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/renderer/src/lib/__tests__/theme.test.ts`
Expected: the 3 `deriveAppTheme borders` tests PASS. The `fleet-dark / fleet-light cool-gray retint` tests still FAIL (border assertions inside contrast tests aren't affected, but the exact-hex tests fail because `theme-presets.ts` hasn't been retinted yet) - the `does not regress WCAG contrast` tests should already PASS since contrast ratios only depend on text/bg/surface, which are unchanged in this task.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/theme.ts
git commit -m "feat(theme): derive translucent hairline borders for all themes (#398)"
```

---

### Task 3: Retint fleet-dark and fleet-light to cool-gray

**Files:**
- Modify: `src/shared/theme-presets.ts:107-119` (fleet-dark `appOverrides`)
- Modify: `src/shared/theme-presets.ts:149-161` (fleet-light `appOverrides`, line numbers shift by the delta from the fleet-dark edit above - locate by the `'fleet-light':` key instead of by line number)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TERMINAL_THEMES['fleet-dark'].appOverrides` and `TERMINAL_THEMES['fleet-light'].appOverrides` no longer include `border`/`borderStrong` keys (so they fall through to Task 2's universal formula), and their color keys use the retinted hex values.

- [ ] **Step 1: Update fleet-dark's `appOverrides`**

In `src/shared/theme-presets.ts`, find the `'fleet-dark'` entry's `appOverrides` block:

```ts
    appOverrides: {
      bg: '#0a0a0a',
      surface: '#171717',
      surface2: '#262626',
      surface3: '#404040',
      border: '#262626',
      borderStrong: '#404040',
      text: '#fafafa',
      textSecondary: '#d4d4d4',
      textMuted: '#a3a3a3',
      textSubtle: '#737373'
    }
```

Replace it with:

```ts
    appOverrides: {
      // Cool-gray tint (OKLCH hue 260, chroma 0.006) instead of flat neutral-*
      // gray, same lightness as before. border/borderStrong are intentionally
      // omitted so they fall through to deriveAppTheme's universal hairline formula.
      bg: '#090a0d',
      surface: '#15171a',
      surface2: '#242629',
      surface3: '#3e4043',
      text: '#f8fafe',
      textSecondary: '#d2d4d8',
      textMuted: '#a1a3a7',
      textSubtle: '#717377'
    }
```

- [ ] **Step 2: Update fleet-light's `appOverrides`**

Find the `'fleet-light'` entry's `appOverrides` block:

```ts
    appOverrides: {
      bg: '#f5f7fa',
      surface: '#ffffff',
      surface2: '#eef2f7',
      surface3: '#e2e8f0',
      border: '#dce3ec',
      borderStrong: '#cbd5e1',
      text: '#0f172a',
      textSecondary: '#334155',
      textMuted: '#64748b',
      textSubtle: '#94a3b8'
    }
```

Replace it with:

```ts
    appOverrides: {
      // Cool-gray tint (OKLCH hue 260, chroma 0.006) instead of flat neutral-*
      // gray, same lightness as before. border/borderStrong are intentionally
      // omitted so they fall through to deriveAppTheme's universal hairline formula.
      bg: '#f5f7fb',
      surface: '#fdffff',
      surface2: '#eff2f6',
      surface3: '#e5e8eb',
      text: '#16181b',
      textSecondary: '#3e4043',
      textMuted: '#717376',
      textSubtle: '#9fa2a5'
    }
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/renderer/src/lib/__tests__/theme.test.ts`
Expected: PASS - all tests in the file, including every case added in Task 1.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: no errors (removing `border`/`borderStrong` from `appOverrides` is valid since `AppThemeTokens` in the `appOverrides` field is typed `Partial<AppThemeTokens>`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/theme-presets.ts
git commit -m "feat(theme): retint fleet-dark/fleet-light to cool-gray (#398)"
```

---

### Task 4: Update `index.css` - `:root` fallback values, radius scale, signature shadow token

**Files:**
- Modify: `src/renderer/src/index.css:19-52` (the `@theme inline` block - no changes needed here, confirm untouched)
- Modify: `src/renderer/src/index.css:95-132` (the `:root` block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `--fleet-shadow-overlay` custom property and `.fleet-shadow-overlay` utility class, consumed by Task 6 (`Overlay.tsx`). `--radius-sm/md/lg/xl` Tailwind theme variables, consumed implicitly by every existing `rounded-sm/md/lg/xl` utility class app-wide (no other file needs to change for this to take effect).

- [ ] **Step 1: Update the `:root` fallback color values**

These mirror fleet-dark and are the initial-paint values used before JS applies the active theme's CSS vars - they must match Task 3's new fleet-dark retint plus Task 2's universal border formula (fleet-dark is the default theme, which is dark, so the dark border overlay applies). Replace:

```css
  --fleet-bg: #0a0a0a;
  --fleet-surface: #171717;
  --fleet-surface-2: #262626;
  --fleet-surface-3: #404040;
  --fleet-border: #262626;
  --fleet-border-strong: #404040;
  --fleet-text: #fafafa;
  --fleet-text-secondary: #d4d4d4;
  --fleet-text-muted: #a3a3a3;
  --fleet-text-subtle: #737373;
```

with:

```css
  --fleet-bg: #090a0d;
  --fleet-surface: #15171a;
  --fleet-surface-2: #242629;
  --fleet-surface-3: #3e4043;
  --fleet-border: oklch(1 0 0 / 0.08);
  --fleet-border-strong: oklch(1 0 0 / 0.16);
  --fleet-text: #f8fafe;
  --fleet-text-secondary: #d2d4d8;
  --fleet-text-muted: #a1a3a7;
  --fleet-text-subtle: #717377;
```

- [ ] **Step 2: Sharpen the radius scale**

Replace:

```css
  --radius: 0.5rem;
```

with:

```css
  --radius: 0.375rem;
```

Then add a new `@theme` block right after the existing `@theme inline` block (after its closing `}` on line 52, before the `/* --- Bundled Nerd Fonts --- */` comment):

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

- [ ] **Step 3: Add the signature overlay shadow token**

Add this inside the `:root` block, right after the `--radius: 0.375rem;` line:

```css
  /* The one signature elevation shadow, reserved for the shared Overlay
     primitive. Borders (not shadows) carry depth everywhere else. */
  --fleet-shadow-overlay:
    0 20px 60px -12px rgba(0, 0, 0, 0.5),
    0 8px 24px -8px rgba(0, 0, 0, 0.35);
```

Then add a utility class near the existing `.fleet-accent-*` utility classes (after the `.fleet-accent-ring-pane` rule, before the `/* Global scrollbar */` comment):

```css
.fleet-shadow-overlay {
  box-shadow: var(--fleet-shadow-overlay);
}
```

- [ ] **Step 4: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors (CSS changes don't affect TS/ESLint, this confirms nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/index.css
git commit -m "feat(theme): sharpen radius scale and add signature overlay shadow (#398)"
```

---

### Task 5: Sync the Windows/Linux title bar overlay colors

**Files:**
- Modify: `src/main/index.ts:250`

**Interfaces:**
- Consumes: nothing new (this hardcodes the same fleet-dark bg/textMuted values as a duplicate, for Electron's native `titleBarOverlay` API which can't read CSS custom properties).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Update the hardcoded colors**

Replace:

```ts
      : { titleBarOverlay: { color: '#0a0a0a', symbolColor: '#a3a3a3', height: 36 } })
```

with:

```ts
      : { titleBarOverlay: { color: '#090a0d', symbolColor: '#a1a3a7', height: 36 } })
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "fix(main): sync titlebar overlay colors with retinted fleet-dark (#398)"
```

---

### Task 6: Apply the signature shadow as the default in the shared `Overlay.tsx` primitive

**Files:**
- Modify: `src/renderer/src/components/Overlay.tsx:58-65`

**Interfaces:**
- Consumes: `.fleet-shadow-overlay` CSS class from Task 4.
- Produces: nothing consumed elsewhere - this is a leaf UI change.

- [ ] **Step 1: Add the class to the panel div**

Replace:

```tsx
      <div
        data-state={state}
        onClick={(e) => e.stopPropagation()}
        className={`duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-2 ${panelClassName}`}
      >
        {children}
      </div>
```

with:

```tsx
      <div
        data-state={state}
        onClick={(e) => e.stopPropagation()}
        className={`duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-2 fleet-shadow-overlay ${panelClassName}`}
      >
        {children}
      </div>
```

Note: most existing `Overlay` consumers pass their own `shadow-lg`/`shadow-xl`/`shadow-2xl` in `panelClassName`, which will keep winning in the cascade for those call sites (per the spec, this is intentional - establishing the pattern, not a visual sweep).

- [ ] **Step 2: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Overlay.tsx
git commit -m "feat(ui): apply signature overlay shadow as Overlay.tsx default (#398)"
```

---

### Task 7: Full verification pass

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions in any other test file.

- [ ] **Step 2: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual visual check**

Launch the dev build (`npm run dev`), or ask the user to look at their already-running instance. Check:
- Default (fleet-dark) theme: corners are visibly sharper, borders read as subtle hairlines rather than solid gray lines, background/surfaces still look correctly layered (no washed-out or muddy panels).
- Switch to fleet-light: same checks, borders should read as a subtle dark hairline rather than a hard gray line.
- Switch to at least one derived theme (e.g. Dracula or Nord): confirm the border/radius changes apply there too, and nothing looks broken (this confirms the "one code change, all 14 themes" mechanism worked).
- Open any modal that uses the shared `Overlay` component (e.g. Git Changes, Clipboard History) - it should still render normally (the new shadow token is present in the CSS but likely visually superseded by the modal's own `shadow-*` class, per the spec - not a regression, just not yet visible).

- [ ] **Step 4: Report results to the user**

Summarize what was verified and ask for confirmation before opening the PR.

---

## Self-Review Notes

- **Spec coverage:** all 5 spec sections have a task - tint (Tasks 1 & 3), elevation ladder (explicitly no task, per spec's "no algorithm change" decision), hairline borders (Tasks 1 & 2), radius (Task 4), signature shadow (Tasks 4 & 6). The `:root` fallback sync and titlebar overlay sync were spec gaps discovered during planning (not explicitly in the spec's 5 numbered changes) and are covered by Tasks 4 and 5 respectively, since leaving them stale would reintroduce the "generic"/inconsistent look the issue is about.
- **Placeholder scan:** none found - every step has literal code/commands.
- **Type consistency:** `AppThemeTokens` fields (`bg`, `surface`, `surface2`, `surface3`, `border`, `borderStrong`, `text`, `textSecondary`, `textMuted`, `textSubtle`) are used consistently across Tasks 1-3; no renames introduced.
