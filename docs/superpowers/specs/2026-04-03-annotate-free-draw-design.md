# Annotate Free Draw — Design Spec

**Date:** 2026-04-03
**Status:** Approved

## Overview

Add drawing/markup tools to Fleet's annotation picker so users can draw freehand strokes, lines, arrows, shapes, and text labels on top of web pages alongside the existing element selection workflow. Drawings are rasterized into the final screenshots — no vector data is persisted.

Inspired by screenshot markup tools. Cursor's Design Mode was reviewed but only supports element selection and area selection — free draw is new territory.

## Approach

**Canvas Overlay** — a full-viewport `<canvas>` element layered between the page content and the picker UI. When a draw tool is active, the canvas captures mouse events. When in Pick mode, the canvas has `pointer-events: none` so clicks pass through to the page for element selection.

Alternatives considered:
- **SVG Drawing Layer:** Extends existing SVG connectors. Rejected because freehand SVG paths cause DOM bloat/jank and rasterizing SVG to PNG requires extra work.
- **Offscreen Canvas + DOM Preview:** Over-engineered for this use case, harder to debug, manual hit-testing needed.

## Mode Switching & Toolbar

The bottom panel (`#fleet-annotate-panel`) gains a tool selector with these modes:

| Mode | Behavior | Shortcut |
|------|----------|----------|
| **Pick** (default) | Existing element selection — highlight, badges, notes | Esc |
| **Pen** | Freehand strokes | P |
| **Line** | Straight lines; hold Shift for arrow tip | L |
| **Shape** | Rectangles / ellipses; sub-toggle between them | S |
| **Text** | Click to place, type inline | T |

Active tool is visually highlighted in the toolbar.

When any draw tool is active:
- Canvas overlay captures mouse events
- Element picker highlight/tooltip is disabled
- Existing annotations (badges, notes, connectors) remain visible underneath

When Pick is active:
- Canvas has `pointer-events: none`
- All existing picker behavior works unchanged

### Drawing Options

- **Color picker:** 5-6 preset colors (red default), displayed as small swatches in the toolbar
- **Stroke width:** Thin / Medium / Thick toggle
- **Undo/Redo:** Ctrl+Z / Ctrl+Shift+Z on a simple action stack of drawing operations

## Canvas Drawing Layer

### Z-index Stacking (bottom to top)

1. Web page content
2. Element highlight overlay
3. **Drawing canvas** (new)
4. Element badges / outlines / connectors
5. Note cards
6. Panel toolbar

### Drawing State

An array of drawing operations:

```typescript
type DrawOp =
  | { type: 'freehand'; points: [number, number][]; color: string; width: number }
  | { type: 'line'; start: [number, number]; end: [number, number]; color: string; width: number; arrow: boolean }
  | { type: 'rect'; origin: [number, number]; size: [number, number]; color: string; width: number }
  | { type: 'ellipse'; center: [number, number]; radii: [number, number]; color: string; width: number }
  | { type: 'text'; position: [number, number]; content: string; color: string; fontSize: number }
```

### Rendering

On each mouse event during drawing, the canvas is cleared and all operations are re-rendered from the array. Simple full-redraw — no dirty-rect optimization needed for the expected volume (dozens of operations).

- Canvas is sized to full viewport, scaled by `devicePixelRatio` for Retina crispness
- Freehand smoothing: skip points closer than ~3px, render with `lineTo` + `lineJoin: 'round'` / `lineCap: 'round'`
- Text placement: click places a temporary `<input>` overlay for typing; on Enter/blur, text is committed as a DrawOp and rendered on canvas

## Rasterization & Output

Compositing happens client-side in the picker at submit time:

1. `webContents.capturePage()` returns the page screenshot (existing flow)
2. Create a temporary offscreen canvas
3. Draw the page screenshot onto it
4. Draw the annotation canvas on top
5. Export composited result as PNG

The main process receives the final composited screenshot — no changes to `annotate-service.ts` or result handling needed.

**Per-element screenshots:** The existing flow crops to element bounds + 20px padding. Drawings within the crop region are naturally included since they're composited onto the full screenshot before cropping.

**Result types:** No changes to `AnnotationResult`, `ElementSelection`, or `AnnotationMeta`. Drawings are visual-only in the screenshots. The `context` field remains the way to add textual context.

## Edge Cases

### Scroll
Canvas is viewport-fixed. Drawings are in viewport coordinates — they don't track with page content on scroll. This matches "marking up a view" rather than "annotating DOM nodes." A subtle cue when entering draw mode could communicate this.

### Window Resize
Canvas resizes with viewport. Existing drawings re-render at original coordinates. Off-screen operations remain in the array (visible if resized back). Canvas is re-scaled for DPR on resize.

### Interaction with Existing Features
- Multi-select, debug mode, note cards — all work as before in Pick mode
- Switching Draw to Pick doesn't clear drawings — they persist for the session
- Cancel discards everything (drawings + selections) as today
- Submit captures both element selections and drawings

### Undo Scope
Undo only affects drawing operations, not element selections. Element deselection uses existing badge-click behavior. Two concerns stay separate.

### No Persistence
Drawings live only in the current annotation session. No save/reopen. Matches existing picker behavior.
