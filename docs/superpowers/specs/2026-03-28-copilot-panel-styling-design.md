# Copilot Panel Styling Redesign

**Date:** 2026-03-28
**Status:** Approved

## Summary

Restyle the copilot floating panel with a pixel-art CRT monitor frame built from sprite assets, replace all custom interactive elements with shadcn/ui components, and apply Baymard Institute & Nielsen Norman Group UX research findings throughout.

## Goals

1. Give the copilot panel a distinctive CRT monitor aesthetic that matches the pixel-art spaceship sprite
2. Use shadcn/ui component patterns for consistency and accessibility
3. Apply all applicable Baymard/NNG research findings from `docs/ux-improvements.md`

## Non-Goals

- No changes to Electron main process or preload
- No changes to the spaceship sprite or its animations
- No changes to IPC channels or data flow

---

## 1. CRT Frame Implementation

### Approach

Position the 7 CRT sprite assets (4 corners, 2 edges, 1 scanline) around the panel content using absolute positioning and CSS tiling.

### Assets

Source: `sprites-raw/star-command/chrome/crt-*.png` (512x512 raw sprites)

Copied and cropped to: `src/renderer/copilot/src/assets/crt/`

| Asset | Raw Size | Content Bounds | Cropped Target |
|-------|----------|----------------|----------------|
| `crt-corner-tl.png` | 512x512 | y=45-511, x=45-511 (467x467) | 32x32 |
| `crt-corner-tr.png` | 512x512 | ~467x467 | 32x32 |
| `crt-corner-bl.png` | 512x512 | ~467x467 | 32x32 |
| `crt-corner-br.png` | 512x512 | ~467x467 | 32x32 |
| `crt-edge-v.png` | 512x512 | x=127-384 (258x512) | 16x(tiled) |
| `crt-edge-h.png` | 512x512 | y=163-307 (512x145) | (tiled)x16 |
| `crt-scanline.png` | 32x32 | full | 32x32 (repeating) |

### Component: `CrtFrame`

```tsx
// Wrapper that renders the CRT bezel around children
<div className="relative">
  {/* Corner images - absolute positioned */}
  <img src={cornerTL} className="absolute top-0 left-0 w-8 h-8 pixelated" />
  <img src={cornerTR} className="absolute top-0 right-0 w-8 h-8 pixelated" />
  <img src={cornerBL} className="absolute bottom-0 left-0 w-8 h-8 pixelated" />
  <img src={cornerBR} className="absolute bottom-0 right-0 w-8 h-8 pixelated" />

  {/* Edge strips - tiled via background-repeat */}
  <div className="absolute top-0 left-8 right-8 h-4 bg-repeat-x pixelated"
       style={{ backgroundImage: `url(${edgeH})` }} />
  <div className="absolute bottom-0 left-8 right-8 h-4 bg-repeat-x pixelated"
       style={{ backgroundImage: `url(${edgeH})`, transform: 'scaleY(-1)' }} />
  <div className="absolute left-0 top-8 bottom-8 w-4 bg-repeat-y pixelated"
       style={{ backgroundImage: `url(${edgeV})` }} />
  <div className="absolute right-0 top-8 bottom-8 w-4 bg-repeat-y pixelated"
       style={{ backgroundImage: `url(${edgeV})`, transform: 'scaleX(-1)' }} />

  {/* Scanline overlay */}
  <div className="absolute inset-8 pointer-events-none opacity-[0.05] bg-repeat"
       style={{ backgroundImage: `url(${scanline})` }} />

  {/* Content with padding to clear frame */}
  <div className="p-8 overflow-hidden">
    {children}
  </div>
</div>
```

All frame images use `image-rendering: pixelated` via a `.pixelated` utility class.

The `CrtFrame` replaces the current `rounded-lg border border-neutral-700` on all three panel views.

---

## 2. Asset Pipeline

1. Copy `crt-*.png` files from `sprites-raw/star-command/chrome/` to `src/renderer/copilot/src/assets/crt/`
2. Crop each sprite to its content bounds using a one-time sharp script
3. Scale down to target frame thickness (~32px corners, ~16px edges) maintaining pixel-art ratios with nearest-neighbor interpolation
4. Import as standard Vite static assets in `CrtFrame.tsx`

This makes the copilot assets independent of the star-command directory (which is scheduled for deletion).

---

## 3. shadcn Component Setup

### Location

`src/renderer/copilot/src/components/ui/`

### Components

| Component | Replaces | Used In |
|-----------|----------|---------|
| `Button` | Custom `<button>` elements | SessionList, SessionDetail, CopilotSettings |
| `Input` | Custom `<input>` | SessionDetail (chat input) |
| `ScrollArea` | `overflow-y-auto` divs | SessionList, SessionDetail (chat area) |
| `Tooltip` | None (new) | All views — status indicators, truncated names, settings |
| `Card` | Custom styled divs | SessionDetail (permission blocks, message bubbles) |
| `DropdownMenu` | Custom `<select>` | CopilotSettings (notification sound) |
| `Badge` | Custom status dots | SessionList (session status) |

### Implementation Notes

- Components follow standard shadcn patterns using Radix primitives + `class-variance-authority`
- Styled with the existing dark palette (`neutral-800/900`, `blue-600`, `amber-500`, etc.)
- No `components.json` — manually created since copilot is a separate renderer entry point
- Radix packages already in `package.json`: tooltip, dropdown-menu, select, dialog, popover, context-menu, separator, switch
- May need to add: `@radix-ui/react-scroll-area`

### Dependencies

- `class-variance-authority` — already in `package.json`
- `clsx` + `tailwind-merge` — already in `package.json`
- `@radix-ui/react-scroll-area` — needs to be added

---

## 4. Baymard/NNG UX Improvements

### 4.1 Multi-Signal Badges (Baymard: Accessibility)

Session status indicators use shape + size + color + animation — color is never the sole signal.

| Status | Shape | Size | Color | Animation |
|--------|-------|------|-------|-----------|
| Idle | Circle dot | Small (6px) | `neutral-500` | None |
| Running | Ring | Medium (8px) | `blue-400` | Pulse |
| Permission | Triangle | Large (10px) | `amber-400` | Pulse-amber |
| Error | Square | Large (10px) | `red-400` | None |
| Complete | Checkmark | Medium (8px) | `green-400` | Flash-green |

Implemented via shadcn `Badge` component with `status` variant.

### 4.2 WCAG Contrast (Baymard: Accessibility)

- All text: minimum 4.5:1 contrast ratio against background
- Non-text interactive elements: minimum 3:1
- `neutral-200` on `neutral-900` = 12.6:1 (passes)
- `amber-400` on `neutral-900` = verified ≥ 3:1
- No pure white (`#fff`) text — use `neutral-200` per NNG dark mode guidelines

### 4.3 Focus Indicators (NNG: Keyboard Navigation)

- All interactive elements get `focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-900`
- 3:1 minimum contrast for the ring
- Keyboard navigation: Tab/Shift+Tab through session list items, Enter to select, Escape to go back

### 4.4 Unified Hit-Areas (Baymard: Hover UX)

- Session list rows: entire row is clickable, not just text
- Minimum 44px row height for touch/click target
- Hover state covers the full row width
- Cursor: pointer on entire row

### 4.5 Truncation + Tooltips (Baymard: Truncation Design)

- Project names in session list truncate with `text-ellipsis overflow-hidden whitespace-nowrap`
- Full name shown via shadcn `Tooltip` on hover
- Tool names in chat messages get the same treatment

### 4.6 Running/Idle State Per Session (Item #7 — Currently Pending)

- Each session row shows a real-time state indicator using the multi-signal badge system (4.1)
- Positioned left of the project name
- Updates reactively via the existing Zustand store session data

### 4.7 "What's This?" Tooltips (Baymard: Tooltip UX)

- Settings options get explanatory `Tooltip` on hover
- Status indicators show meaning on hover (e.g., "Waiting for permission")
- Hook status shows what hooks do when hovered

### 4.8 Dark Mode Contrast (NNG: Dark Mode Issues)

- Avoid pure white text — use `neutral-200` maximum
- Layered dark surfaces use sufficient contrast: `neutral-900` (base) → `neutral-800` (elevated) → `neutral-700` (borders)
- No large blocks of pure black

---

## 5. File Changes

### New Files

| File | Purpose |
|------|---------|
| `src/renderer/copilot/src/components/CrtFrame.tsx` | CRT bezel wrapper component |
| `src/renderer/copilot/src/components/ui/button.tsx` | shadcn Button |
| `src/renderer/copilot/src/components/ui/input.tsx` | shadcn Input |
| `src/renderer/copilot/src/components/ui/scroll-area.tsx` | shadcn ScrollArea |
| `src/renderer/copilot/src/components/ui/tooltip.tsx` | shadcn Tooltip |
| `src/renderer/copilot/src/components/ui/card.tsx` | shadcn Card |
| `src/renderer/copilot/src/components/ui/dropdown-menu.tsx` | shadcn DropdownMenu |
| `src/renderer/copilot/src/components/ui/badge.tsx` | shadcn Badge with status variants |
| `src/renderer/copilot/src/lib/utils.ts` | `cn()` utility (clsx + tailwind-merge) |
| `src/renderer/copilot/src/assets/crt/*.png` | Cropped CRT frame sprites (7 files) |

### Modified Files

| File | Changes |
|------|---------|
| `App.tsx` | Wrap expanded panel content in `CrtFrame`; remove old border styling |
| `SessionList.tsx` | Use ScrollArea, Badge, Tooltip, Button; unified hit-areas; 44px rows; truncation+tooltip; focus indicators |
| `SessionDetail.tsx` | Use ScrollArea, Button, Input, Card, Tooltip; permission blocks as Cards; focus ring on input |
| `ChatMessage.tsx` | Use Card for message bubbles; Tooltip on tool names |
| `CopilotSettings.tsx` | Use Button, DropdownMenu, Tooltip for "what's this?" hints |
| `index.css` | Add `.pixelated` utility; focus-visible utilities; CSS custom properties for palette |
| `package.json` | Add `class-variance-authority`, `@radix-ui/react-scroll-area`, `clsx`, `tailwind-merge` |

### Unchanged

- Electron main process (`copilot-window.ts`)
- Preload (`copilot.ts`)
- IPC channels
- Zustand store (`copilot-store.ts`)
- SpaceshipSprite component
