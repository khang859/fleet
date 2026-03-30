# Copilot Centered Rich Pane

## Overview

Replace the copilot's small anchored side panel (350x500, direction-dependent) with a centered 600x500 rich pane overlay. Clicking the mascot teleports it into the pane header and opens a full-screen backdrop. All copilot views render inside the larger pane.

## Motivation

The current side panel is cramped at 350x500 and its position depends on where the mascot is on screen (panel direction logic). A centered pane provides more room for sessions, chat, and settings, and eliminates the complexity of directional anchoring. The backdrop also creates a canvas for future sci-fi themed assets.

## Approach

Resize the existing transparent Electron `BrowserWindow` to cover the full display work area. Render the backdrop and centered pane within the same renderer. No new windows or processes.

## Window Lifecycle

### Collapsed State
- 128x128 transparent window, mascot visible, draggable, always-on-top
- No change from current behavior

### Expanding
1. Save the mascot's current screen position (`savedPosition`) for later restoration
2. Play teleport-out animation on mascot (~200ms)
3. Get the current display's work area via `screen.getDisplayNearestPoint()`
4. `setBounds()` to cover the full work area
5. `setIgnoreMouseEvents(false)` so the full-screen window captures all clicks
6. Renderer shows the backdrop div + centered 600x500 pane
7. Play teleport-in animation on mascot in pane header (~200ms)
8. Window remains always-on-top at `'pop-up-menu'` level

### Collapsing
1. Play teleport-out animation on mascot in header (~200ms)
2. Renderer hides backdrop + pane
3. `setBounds()` back to 128x128 at `savedPosition`
4. Restore normal mouse event handling for transparent click-through
5. Play teleport-in animation on mascot at floating position (~200ms)
6. Reset view to `'sessions'`

## Renderer Layout

### Expanded Structure

```
<div className="fixed inset-0">                    // full-screen container
  <div className="backdrop" onClick={close} />      // semi-transparent bg
  <div className="centered-pane">                   // 600x500 centered
    <PaneHeader>                                    // mascot + title
      <SpaceshipSprite mode="header" />             // 48x48, no drag, click-to-close
      <span>Fleet Copilot</span>
    </PaneHeader>
    <PaneBody>                                      // existing views
      <CrtFrame>
        {view === 'sessions' && <SessionList />}
        {view === 'detail'   && <SessionDetail />}
        {view === 'settings' && <CopilotSettings />}
        {view === 'mascots'  && <MascotPicker />}
      </CrtFrame>
    </PaneBody>
  </div>
</div>
```

### Backdrop
- `bg-black/60` for now
- Structured as its own div so sci-fi background images/assets can be layered in later
- Click on backdrop closes the pane (`e.stopPropagation()` on the pane prevents close when clicking inside it)

### Collapsed Structure
- Same as current: just `<SpaceshipSprite mode="floating" />` at 128x128

## Component Changes

### SpaceshipSprite
- Add `mode` prop: `'floating'` | `'header'`
- `'floating'`: Current behavior — 128x128, draggable, click toggles expand
- `'header'`: 48x48 (CSS scale or explicit sizing), no drag, click triggers close
- Animation loop continues in both modes (idle bob stays alive in header)

### App.tsx (copilot renderer)
- Orchestrates between collapsed and expanded layouts
- Manages teleport animation state machine
- Handles Escape key listener when expanded

### SessionList, SessionDetail, CopilotSettings, MascotPicker
- No structural changes — they render inside a larger container and naturally have more room (600px vs 350px)

### CrtFrame
- Still wraps the pane body for CRT aesthetic

## State Changes

### Zustand Store (`copilot-store.ts`)
- `expanded`: boolean — stays as-is
- `panelDirection`: **removed** — no longer needed
- `savedPosition: { x: number, y: number } | null`: **added** — where mascot was before expand
- `view`: reset to `'sessions'` on close

### Main Process (`copilot-window.ts`)
- `toggleExpanded()` reworked:
  - Expand: save bounds, get display work area, `setBounds()` to full work area
  - Collapse: `setBounds()` back to 128x128 at saved position
- Remove panel direction calculation logic (horizontal/vertical checks, anchor positioning)
- Remove `EXPANDED_WIDTH` and `EXPANDED_HEIGHT` constants
- Keep `setAlwaysOnTop(true, 'pop-up-menu')` when expanded

### IPC Changes
- `copilot:expanded-changed` payload simplifies: `{ expanded: boolean }` — no more `direction` object
- `copilot:set-expanded` and `copilot:toggle-expanded` unchanged
- Preload API: remove `direction` from `onExpandedChanged` callback signature

## Teleport Animation

### Flash Out (~200ms)
1. White flash overlay on mascot sprite for ~100ms (opacity pulse to bright)
2. Mascot fades to transparent over ~100ms

### Flash In (~200ms)
1. Mascot starts invisible at destination
2. Brief white flash/glow at position for ~100ms
3. Mascot fades in over ~100ms

### Implementation
- CSS `@keyframes` animations: `teleport-out` and `teleport-in`
- Classes toggled via component state
- Window resize triggered between the two animations with ~200ms delay
- Total transition time: ~400ms

### Reverse
Same effect on close — flash out in header, window resizes, flash in at floating position.

## Close Interactions

Three close triggers:
1. **Mascot click in header**: `SpaceshipSprite` in `'header'` mode click calls `toggleExpanded()`
2. **Backdrop click**: Backdrop div `onClick` calls `toggleExpanded()`; pane uses `e.stopPropagation()`
3. **Escape key**: `keydown` listener on expanded container; cleaned up on collapse

On close, `view` resets to `'sessions'`.

## What Gets Removed

- Panel direction calculation logic in `copilot-window.ts`
- `EXPANDED_WIDTH` and `EXPANDED_HEIGHT` constants (pane sizing moves to CSS)
- `panelDirection` from Zustand store
- `direction` from IPC payloads and preload API
- Directional positioning code in `App.tsx` (top/bottom panel anchor logic)
