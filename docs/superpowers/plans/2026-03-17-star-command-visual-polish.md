# Star Command Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pixel art chrome, sprite-based animations, avatars, and particle effects to the Star Command tab.

**Architecture:** Separate sprite sheet (`star-command-sprites.png`) with its own assembly script and atlas. DOM/CSS components for static chrome (CRT frame, status bar, avatars). Canvas renderers for dynamic elements (shuttles, particles, orbs) integrated into SpaceCanvas's existing 30fps active-layer RAF loop.

**Tech Stack:** React, TypeScript, sharp (sprite assembly), fal.ai (asset generation), Canvas 2D API, CSS sprite animations.

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `scripts/assemble-star-command-sprites.ts` | Assembly script for SC sprite sheet |
| `docs/star-command-visual-prompts.md` | fal.ai prompt list for all 52 assets |
| `src/renderer/src/components/star-command/sc-sprite-atlas.ts` | Auto-generated atlas (coordinates + frame data) |
| `src/renderer/src/components/star-command/sc-sprite-loader.ts` | Image loader + draw helpers |
| `src/renderer/src/components/star-command/CrtFrame.tsx` | CRT bezel wrapper component |
| `src/renderer/src/components/star-command/StatusBar.tsx` | Metal status bar with rivets |
| `src/renderer/src/components/star-command/CrewChips.tsx` | Status chip badges grouped by sector |
| `src/renderer/src/components/star-command/Avatar.tsx` | Pixel art portrait renderer |
| `src/renderer/src/components/visualizer/shuttle-anim.ts` | Shuttle dock/undock animator |
| `src/renderer/src/components/visualizer/sc-particles.ts` | One-shot particle effect system |

### Modified Files
| File | Changes |
|------|---------|
| `src/renderer/src/components/StarCommandTab.tsx` | Wrap in CrtFrame, add StatusBar, add avatars to messages/status panel |
| `src/renderer/src/components/visualizer/SpaceCanvas.tsx` | Integrate shuttle animator, particle system, crew list diffing, comms beam wiring |
| `src/renderer/src/components/visualizer/crew-pods.ts` | Add sprite overlays for beacon, checkmark, enhanced status effects |
| `src/renderer/src/components/visualizer/comms-beams.ts` | Replace circles with sprite orbs, add beam types, add bezier cargo paths |
| `src/renderer/src/store/star-command-store.ts` | Add `recentComms` field + `admiralAvatarState` field |

---

## Task 1: Assembly Script

Write the sprite sheet assembly script that reads from `sprites-raw/star-command/` and outputs the sprite sheet PNG + TypeScript atlas.

**Files:**
- Create: `scripts/assemble-star-command-sprites.ts`

- [ ] **Step 1: Write the assembly script**

Model it on `scripts/assemble-sprites.ts`. Key differences:
- Input dir: `sprites-raw/star-command/` (subdirs: `avatars/`, `chrome/`, `shuttle/`, `particles/`, `orbs/`, `beacon/`)
- Output sheet: `src/renderer/src/assets/star-command-sprites.png`
- Output atlas: `src/renderer/src/components/star-command/sc-sprite-atlas.ts`
- Sheet size: 512x512
- Layout per the pixel-level map in the spec (rows 0-5, max extent 320x224)

The manifest must define all 52 sprites with their exact (x, y, w, h) positions matching the spec layout:
- Row 0 (y=0): 5 admiral avatars at 64x64
- Row 1 (y=64): 5 crew avatars at 64x64
- Row 2 (y=128): 7 CRT frame pieces (mixed sizes)
- Row 3 (y=160): 3 statusbar + 7 chip sprites
- Row 4 (y=184): 4 shuttle + 2 spark + 3 gas-puff
- Row 5 (y=208): 4 explosion + 3 dock-sparkle + 3 thruster-flame + checkmark + 3 orbs + 2 beacon

Numbered source files (e.g., `shuttle-thrust-1.png`, `shuttle-thrust-2.png`, `shuttle-thrust-3.png`) get grouped into a single atlas entry with `frames: 3`.

The generated atlas file must define its own `SpriteRegion` interface inline (same shape as `src/renderer/src/components/visualizer/sprite-atlas.ts:3-16`) and export `SC_SPRITE_ATLAS: Record<string, SpriteRegion>`.

Frame durations:
- `shuttle-thrust`: 100ms
- `spark`: 300ms
- `gas-puff`: 200ms
- `explosion`: 100ms
- `dock-sparkle`: 150ms
- `thruster-flame`: 100ms
- `beacon`: 500ms (on/off alternation)
- All single-frame sprites: frameDuration 0

```typescript
// Key structure reference for the atlas output:
export const SC_SPRITE_ATLAS: Record<string, SpriteRegion> = {
  'admiral-default': { x: 0, y: 0, w: 64, h: 64, frames: 1, frameDuration: 0 },
  'admiral-speaking': { x: 64, y: 0, w: 64, h: 64, frames: 1, frameDuration: 0 },
  'admiral-thinking': { x: 128, y: 0, w: 64, h: 64, frames: 1, frameDuration: 0 },
  'admiral-alert': { x: 192, y: 0, w: 64, h: 64, frames: 1, frameDuration: 0 },
  'admiral-standby': { x: 256, y: 0, w: 64, h: 64, frames: 1, frameDuration: 0 },
  // ... etc for all 52 sprites / grouped entries
}
```

- [ ] **Step 2: Verify the script compiles**

Run: `npx tsx scripts/assemble-star-command-sprites.ts`
Expected: Fails with "Missing N sprite files" (expected — no raw sprites yet). Confirms the script runs and the manifest is correct.

- [ ] **Step 3: Commit**

```bash
git add scripts/assemble-star-command-sprites.ts
git commit -m "feat(star-command): add sprite sheet assembly script"
```

---

## Task 2: Sprite Loader

Write the loader module that loads the Star Command sprite sheet and provides draw helpers for both canvas and DOM usage.

**Files:**
- Create: `src/renderer/src/components/star-command/sc-sprite-loader.ts`

- [ ] **Step 1: Write the sprite loader**

Mirror the API of `src/renderer/src/components/visualizer/sprite-loader.ts`. Key functions:

```typescript
import scSpriteSheetUrl from '../../assets/star-command-sprites.png'
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas'
import type { SpriteRegion } from './sc-sprite-atlas'

let spriteSheet: HTMLImageElement | null = null
let spriteReady = false

export function loadScSpriteSheet(): void {
  if (spriteSheet) return
  const img = new Image()
  img.src = scSpriteSheetUrl
  img.onload = () => {
    spriteSheet = img
    spriteReady = true
  }
}

export function isScSpriteReady(): boolean {
  return spriteReady
}

export function getScSpriteSheet(): HTMLImageElement | null {
  return spriteSheet
}

/** URL for CSS background-image usage (non-repeating sprites only) */
export function getScSpriteSheetUrl(): string {
  return scSpriteSheetUrl
}

/**
 * Extract a single sprite tile as a standalone data URL.
 * Required for CSS background-repeat on sprite sheet sub-regions,
 * since background-repeat tiles the entire sheet, not a sub-region.
 * Results are cached.
 */
const tileCache = new Map<string, string>()
export function getScTileUrl(key: string): string {
  const cached = tileCache.get(key)
  if (cached) return cached
  if (!spriteSheet) return ''
  const region = SC_SPRITE_ATLAS[key]
  if (!region) return ''

  const canvas = document.createElement('canvas')
  canvas.width = region.w
  canvas.height = region.h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(spriteSheet, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h)
  const url = canvas.toDataURL('image/png')
  tileCache.set(key, url)
  return url
}

/** Compute current animation frame index */
export function getScFrame(region: SpriteRegion, elapsed: number): number {
  if (region.frames <= 1 || region.frameDuration <= 0) return 0
  const totalDuration = region.frames * region.frameDuration
  return Math.floor((elapsed % totalDuration) / region.frameDuration)
}

/** Draw a sprite region (auto-animated) */
export function drawScSprite(
  ctx: CanvasRenderingContext2D,
  key: string,
  elapsed: number,
  dx: number,
  dy: number,
  dw?: number,
  dh?: number,
): void {
  if (!spriteSheet) return
  const region = SC_SPRITE_ATLAS[key]
  if (!region) return
  const frame = getScFrame(region, elapsed)
  const sx = region.x + frame * region.w
  const w = dw ?? region.w
  const h = dh ?? region.h
  ctx.drawImage(spriteSheet, sx, region.y, region.w, region.h, dx, dy, w, h)
}

/** Draw a specific frame (no animation) */
export function drawScSpriteFrame(
  ctx: CanvasRenderingContext2D,
  key: string,
  frameIndex: number,
  dx: number,
  dy: number,
  dw?: number,
  dh?: number,
): void {
  if (!spriteSheet) return
  const region = SC_SPRITE_ATLAS[key]
  if (!region) return
  const sx = region.x + frameIndex * region.w
  const w = dw ?? region.w
  const h = dh ?? region.h
  ctx.drawImage(spriteSheet, sx, region.y, region.w, region.h, dx, dy, w, h)
}
```

Note: This will have a TypeScript import error for `star-command-sprites.png` until the sprite sheet is generated. That's expected — the assembly script creates it. For now the file is structurally correct.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/star-command/sc-sprite-loader.ts
git commit -m "feat(star-command): add sprite sheet loader module"
```

---

## Task 3: Asset Prompts Document

Document all fal.ai prompts for generating the 52 sprite images.

**Files:**
- Create: `docs/star-command-visual-prompts.md`

- [ ] **Step 1: Write the prompt document**

For each of the 52 images, document:
- Output path (relative to `sprites-staging/star-command/`)
- fal.ai prompt text (consistent style prefix: "16-bit pixel art, retro game aesthetic, deep navy and teal color palette, transparent background,")
- Any special options (aspect ratio, reference image for edit variants)

Group by category (avatars, chrome, shuttle, particles, orbs, beacon). Include the shell command for each:

```bash
npx tsx scripts/generate-image.ts "16-bit pixel art portrait, retro game aesthetic, 64x64, sci-fi commander character with long dark coat, high collar, teal glowing headset, deep navy background, transparent background" --output star-command/avatars/admiral-default.png
```

For edit-based variants (e.g., admiral-speaking from admiral-default):
```bash
npx tsx scripts/generate-image.ts "same character, mouth open, headset glow brighter" --output star-command/avatars/admiral-speaking.png --reference star-command/avatars/admiral-default.png
```

- [ ] **Step 2: Commit**

```bash
git add docs/star-command-visual-prompts.md
git commit -m "docs: add fal.ai prompts for star command visual assets"
```

---

## Task 4: Generate Assets & Assemble Sheet

Generate all 52 images, remove backgrounds, and assemble the sprite sheet. This is a manual/semi-automated step.

- [ ] **Step 1: Generate images**

Run the generate commands from `docs/star-command-visual-prompts.md`. Start with one category at a time. Check each image visually — regenerate with adjusted prompts if needed.

- [ ] **Step 2: Remove backgrounds**

```bash
npx tsx scripts/remove-background.ts
```

This processes all images in `sprites-staging/star-command/` → `sprites-raw/star-command/`.

- [ ] **Step 3: Assemble sprite sheet**

```bash
npx tsx scripts/assemble-star-command-sprites.ts
```

Expected: "Sprite sheet written to: src/renderer/src/assets/star-command-sprites.png" and "Atlas written to: src/renderer/src/components/star-command/sc-sprite-atlas.ts"

- [ ] **Step 4: Verify output**

Open `src/renderer/src/assets/star-command-sprites.png` in an image viewer. Verify all sprites are correctly positioned and have transparent backgrounds. Check `sc-sprite-atlas.ts` has all expected keys.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/assets/star-command-sprites.png src/renderer/src/components/star-command/sc-sprite-atlas.ts sprites-raw/star-command/
git commit -m "feat(star-command): generate pixel art sprite sheet and atlas"
```

---

## Task 5: CRT Frame Component

Wrap the Star Command chat area in a CRT bezel frame using sprite tiles.

**Files:**
- Create: `src/renderer/src/components/star-command/CrtFrame.tsx`
- Modify: `src/renderer/src/components/StarCommandTab.tsx`

- [ ] **Step 1: Create CrtFrame component**

```tsx
import { type ReactNode, useState, useEffect } from 'react'
import { getScSpriteSheetUrl, getScTileUrl, isScSpriteReady } from './sc-sprite-loader'
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas'

type CrtFrameProps = { children: ReactNode }

/**
 * NOTE on tiling: CSS background-repeat tiles the ENTIRE background image,
 * not a sub-region of a sprite sheet. For repeating tiles (edges, scanlines),
 * we use getScTileUrl() which extracts the sub-region into a standalone
 * data URL that can be tiled correctly.
 */

function SpriteDiv({ spriteKey, className, style }: {
  spriteKey: string
  className?: string
  style?: React.CSSProperties
}) {
  const region = SC_SPRITE_ATLAS[spriteKey]
  if (!region) return null
  return (
    <div
      className={className}
      style={{
        backgroundImage: `url(${getScSpriteSheetUrl()})`,
        backgroundPosition: `-${region.x}px -${region.y}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
        width: region.w,
        height: region.h,
        ...style,
      }}
    />
  )
}

export function CrtFrame({ children }: CrtFrameProps) {
  // Force re-render when sprite sheet finishes loading (for tile URLs)
  const [ready, setReady] = useState(isScSpriteReady())
  useEffect(() => {
    if (ready) return
    const interval = setInterval(() => {
      if (isScSpriteReady()) { setReady(true); clearInterval(interval) }
    }, 100)
    return () => clearInterval(interval)
  }, [ready])

  const edgeH = SC_SPRITE_ATLAS['crt-edge-h']
  const edgeV = SC_SPRITE_ATLAS['crt-edge-v']

  // Extract tile URLs for repeating backgrounds
  const edgeHUrl = getScTileUrl('crt-edge-h')
  const edgeVUrl = getScTileUrl('crt-edge-v')
  const scanlineUrl = getScTileUrl('crt-scanline')

  return (
    <div className="flex flex-col h-full relative">
      {/* Top edge: corner-tl + repeating edge-h + corner-tr */}
      <div className="flex flex-shrink-0">
        <SpriteDiv spriteKey="crt-corner-tl" />
        <div
          className="flex-1"
          style={{
            backgroundImage: edgeHUrl ? `url(${edgeHUrl})` : 'none',
            backgroundRepeat: 'repeat-x',
            imageRendering: 'pixelated',
            height: edgeH?.h ?? 8,
          }}
        />
        <SpriteDiv spriteKey="crt-corner-tr" />
      </div>

      {/* Middle: edge-v + content + edge-v */}
      <div className="flex flex-1 min-h-0">
        <div
          className="flex-shrink-0"
          style={{
            backgroundImage: edgeVUrl ? `url(${edgeVUrl})` : 'none',
            backgroundRepeat: 'repeat-y',
            imageRendering: 'pixelated',
            width: edgeV?.w ?? 8,
          }}
        />
        <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
          {children}
          {/* Scanline overlay */}
          <div
            className="absolute inset-0 pointer-events-none z-10"
            style={{
              backgroundImage: scanlineUrl ? `url(${scanlineUrl})` : 'none',
              backgroundRepeat: 'repeat',
              imageRendering: 'pixelated',
              opacity: 0.04,
            }}
          />
        </div>
        <div
          className="flex-shrink-0"
          style={{
            backgroundImage: edgeVUrl ? `url(${edgeVUrl})` : 'none',
            backgroundRepeat: 'repeat-y',
            imageRendering: 'pixelated',
            width: edgeV?.w ?? 8,
          }}
        />
      </div>

      {/* Bottom edge: corner-bl + repeating edge-h + corner-br */}
      <div className="flex flex-shrink-0">
        <SpriteDiv spriteKey="crt-corner-bl" />
        <div
          className="flex-1"
          style={{
            backgroundImage: edgeHUrl ? `url(${edgeHUrl})` : 'none',
            backgroundRepeat: 'repeat-x',
            imageRendering: 'pixelated',
            height: edgeH?.h ?? 8,
          }}
        />
        <SpriteDiv spriteKey="crt-corner-br" />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Integrate CrtFrame into StarCommandTab**

In `src/renderer/src/components/StarCommandTab.tsx`, wrap the chat panel content (the `flex-1 flex flex-col` div at line 301) with `<CrtFrame>`. The status panel sidebar stays outside the frame.

Replace the outer `<div className="h-full flex">` content structure:

```tsx
import { CrtFrame } from './star-command/CrtFrame'
import { loadScSpriteSheet } from './star-command/sc-sprite-loader'

// In StarCommandTab component, add to the first useEffect or top of component:
useEffect(() => { loadScSpriteSheet() }, [])

// Wrap the chat panel:
<div className="h-full flex">
  <CrtFrame>
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header bar */}
      {/* ... existing header ... */}
      {/* Chat or Config content */}
      {/* ... existing content ... */}
    </div>
  </CrtFrame>
  <StatusPanel />
</div>
```

- [ ] **Step 3: Verify visually**

Run: `npm run dev`
Open Star Command tab. The chat area should have a pixel art CRT bezel frame around it with faint scanlines. The status panel sidebar should be outside the frame.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/star-command/CrtFrame.tsx src/renderer/src/components/StarCommandTab.tsx
git commit -m "feat(star-command): add CRT bezel frame chrome"
```

---

## Task 6: Status Bar Component

Add a metal-textured status bar at the top of the CRT frame content area.

**Files:**
- Create: `src/renderer/src/components/star-command/StatusBar.tsx`
- Modify: `src/renderer/src/components/StarCommandTab.tsx`

- [ ] **Step 1: Create StatusBar component**

```tsx
import { useStarCommandStore } from '../../store/star-command-store'
import { getScSpriteSheetUrl, getScTileUrl } from './sc-sprite-loader'
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas'

export function StatusBar() {
  const { crewList, sectors } = useStarCommandStore()
  const url = getScSpriteSheetUrl()
  const rivet = SC_SPRITE_ATLAS['statusbar-rivet']

  // Use extracted tile URL for repeating background (not sprite sheet sub-region)
  const tileUrl = getScTileUrl('statusbar-tile')

  const activeCrew = crewList.filter((c) => c.status === 'active').length
  const totalCrew = crewList.length
  const activeSectors = new Set(
    crewList.filter((c) => c.status === 'active').map((c) => c.sector_id)
  )

  return (
    <div
      className="flex items-center justify-between px-3 flex-shrink-0 relative"
      style={{
        backgroundImage: tileUrl ? `url(${tileUrl})` : 'none',
        backgroundRepeat: 'repeat-x',
        imageRendering: 'pixelated',
        height: 24,
      }}
    >
      {/* Rivets at fixed intervals */}
      {[40, 120, 200].map((left) => (
        <div
          key={left}
          className="absolute"
          style={{
            backgroundImage: `url(${url})`,
            backgroundPosition: `-${rivet.x}px -${rivet.y}px`,
            backgroundRepeat: 'no-repeat',
            imageRendering: 'pixelated',
            width: rivet.w,
            height: rivet.h,
            left,
            top: (24 - rivet.h) / 2,
          }}
        />
      ))}

      <span className="text-[10px] font-mono text-teal-400 uppercase tracking-wider relative z-10">
        Starbase
      </span>
      <span className="text-[10px] font-mono text-neutral-400 relative z-10">
        {activeCrew}/{totalCrew} crew • {activeSectors.size}/{sectors.length} sectors active
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Add StatusBar to StarCommandTab**

In `src/renderer/src/components/StarCommandTab.tsx`, render `<StatusBar />` inside the CrtFrame, above the existing header:

```tsx
import { StatusBar } from './star-command/StatusBar'

// Inside CrtFrame children, before the header div:
<CrtFrame>
  <StatusBar />
  <div className="flex-1 flex flex-col min-w-0">
    {/* existing header + content */}
  </div>
</CrtFrame>
```

- [ ] **Step 3: Verify visually**

Run: `npm run dev`
The metal status bar should appear at the top of the CRT frame with rivets and crew/sector count.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/star-command/StatusBar.tsx src/renderer/src/components/StarCommandTab.tsx
git commit -m "feat(star-command): add metal status bar with rivets"
```

---

## Task 7: Crew Status Chips

Add colored status badges inside the status bar, grouped by sector.

**Files:**
- Create: `src/renderer/src/components/star-command/CrewChips.tsx`
- Modify: `src/renderer/src/components/star-command/StatusBar.tsx`

- [ ] **Step 1: Create CrewChips component**

```tsx
import { memo } from 'react'
import { useStarCommandStore } from '../../store/star-command-store'
import { getScSpriteSheetUrl } from './sc-sprite-loader'
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas'

const STATUS_DOT_KEYS: Record<string, string> = {
  active: 'chip-dot-active',
  hailing: 'chip-dot-hailing',
  error: 'chip-dot-error',
  complete: 'chip-dot-complete',
  idle: 'chip-dot-idle',
  lost: 'chip-dot-lost',
}

export const CrewChips = memo(function CrewChips() {
  const { crewList, sectors } = useStarCommandStore()
  const url = getScSpriteSheetUrl()
  const chipFrame = SC_SPRITE_ATLAS['chip-frame']

  if (crewList.length === 0) return null

  // Group crew by sector
  const bySector = new Map<string, typeof crewList>()
  for (const crew of crewList) {
    const list = bySector.get(crew.sector_id) ?? []
    list.push(crew)
    bySector.set(crew.sector_id, list)
  }

  const divider = SC_SPRITE_ATLAS['statusbar-divider']

  return (
    <div className="flex items-center gap-1 overflow-x-auto px-2 py-0.5 scrollbar-none">
      {Array.from(bySector.entries()).map(([sectorId, sectorCrew], idx) => {
        const sector = sectors.find((s) => s.id === sectorId)
        return (
          <div key={sectorId} className="flex items-center gap-1 flex-shrink-0">
            {/* Sector divider between groups (skip first) */}
            {idx > 0 && divider && (
              <div
                style={{
                  backgroundImage: `url(${url})`,
                  backgroundPosition: `-${divider.x}px -${divider.y}px`,
                  backgroundRepeat: 'no-repeat',
                  imageRendering: 'pixelated',
                  width: divider.w,
                  height: divider.h,
                }}
                className="mx-1"
              />
            )}
            <span className="text-[9px] font-mono text-neutral-500 uppercase">
              {sector?.name ?? sectorId}
            </span>
            {sectorCrew.map((crew) => {
              const dotKey = STATUS_DOT_KEYS[crew.status] ?? 'chip-dot-idle'
              const dot = SC_SPRITE_ATLAS[dotKey]
              return (
                <div
                  key={crew.id}
                  className="relative flex items-center gap-1 px-1"
                  style={{
                    backgroundImage: `url(${url})`,
                    backgroundPosition: `-${chipFrame.x}px -${chipFrame.y}px`,
                    backgroundRepeat: 'no-repeat',
                    imageRendering: 'pixelated',
                    height: chipFrame.h,
                    minWidth: chipFrame.w,
                  }}
                >
                  {dot && (
                    <div
                      style={{
                        backgroundImage: `url(${url})`,
                        backgroundPosition: `-${dot.x}px -${dot.y}px`,
                        backgroundRepeat: 'no-repeat',
                        imageRendering: 'pixelated',
                        width: dot.w,
                        height: dot.h,
                      }}
                    />
                  )}
                  <span className="text-[8px] font-mono text-neutral-300 truncate max-w-[60px]">
                    {crew.id}
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
})
```

- [ ] **Step 2: Embed CrewChips in StatusBar**

In `src/renderer/src/components/star-command/StatusBar.tsx`, add `<CrewChips />` between the left label and right summary:

```tsx
import { CrewChips } from './CrewChips'

// In the StatusBar JSX, between the two spans:
<span className="...">Starbase</span>
<CrewChips />
<span className="...">...</span>
```

- [ ] **Step 3: Verify visually**

Run: `npm run dev`
Deploy some crew via the Admiral. Chips should appear in the status bar grouped by sector with colored dots.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/star-command/CrewChips.tsx src/renderer/src/components/star-command/StatusBar.tsx
git commit -m "feat(star-command): add crew status chips to status bar"
```

---

## Task 8: Avatar Component

Create the avatar portrait component and integrate it into chat messages and status panel.

**Files:**
- Create: `src/renderer/src/components/star-command/Avatar.tsx`
- Modify: `src/renderer/src/components/StarCommandTab.tsx`
- Modify: `src/renderer/src/store/star-command-store.ts`

- [ ] **Step 1: Add admiralAvatarState to the store**

In `src/renderer/src/store/star-command-store.ts`, add a new field and action.

Add to the `StarCommandStore` type (after line 45):
```typescript
admiralAvatarState: 'standby' | 'thinking' | 'speaking' | 'alert'
setAdmiralAvatarState: (state: 'standby' | 'thinking' | 'speaking' | 'alert') => void
```

Add default and action in the store creation (after line 71):
```typescript
admiralAvatarState: 'standby',
setAdmiralAvatarState: (state) => set({ admiralAvatarState: state }),
```

Update `setIsStreaming` to also set avatar state. When streaming starts → `'thinking'`. Update `appendStreamText` to switch to `'speaking'` on first chunk. Update `finalizeAssistantMessage` and `setStreamError` to return to `'standby'` (or `'alert'` on error).

In `appendStreamText` (line 87-91):
```typescript
appendStreamText: (text) => {
  set((state) => ({
    streamBuffer: state.streamBuffer + text,
    admiralAvatarState: 'speaking',
  }))
},
```

In `setIsStreaming` (line 160):
```typescript
setIsStreaming: (streaming) => set({
  isStreaming: streaming,
  ...(streaming ? { admiralAvatarState: 'thinking' } : {}),
}),
```

In `finalizeAssistantMessage` — already sets `isStreaming: false`, add `admiralAvatarState: 'standby'` to both branches.

In `setStreamError` — add `admiralAvatarState: 'alert'`.

- [ ] **Step 2: Create Avatar component**

```tsx
import { getScSpriteSheetUrl } from './sc-sprite-loader'
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas'

type AvatarProps = {
  type: 'admiral' | 'crew'
  variant?: string  // crew: hoodie|headphones|robot|cap|glasses. admiral state: default|speaking|thinking|alert|standby
  size?: number     // display size in px, default 32
}

const ADMIRAL_STATES = ['default', 'speaking', 'thinking', 'alert', 'standby'] as const
const CREW_VARIANTS = ['hoodie', 'headphones', 'robot', 'cap', 'glasses'] as const

export function Avatar({ type, variant, size = 32 }: AvatarProps) {
  const url = getScSpriteSheetUrl()

  let key: string
  if (type === 'admiral') {
    const state = variant && ADMIRAL_STATES.includes(variant as typeof ADMIRAL_STATES[number])
      ? variant : 'default'
    key = `admiral-${state}`
  } else {
    const v = variant && CREW_VARIANTS.includes(variant as typeof CREW_VARIANTS[number])
      ? variant : 'hoodie'
    key = `crew-${v}`
  }

  const region = SC_SPRITE_ATLAS[key]
  if (!region) return null

  return (
    <div
      className="flex-shrink-0"
      style={{
        backgroundImage: `url(${url})`,
        backgroundPosition: `-${region.x}px -${region.y}px`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: 'auto',
        imageRendering: 'pixelated',
        width: size,
        height: size,
        // Scale the sprite if size differs from region size
        ...(size !== region.w ? {
          backgroundSize: `${512 * (size / region.w)}px auto`,
          backgroundPosition: `-${region.x * (size / region.w)}px -${region.y * (size / region.h)}px`,
        } : {}),
      }}
    />
  )
}
```

- [ ] **Step 3: Add avatars to StarCommandTab**

In `src/renderer/src/components/StarCommandTab.tsx`:

**MessageBubble** — For assistant messages, add Admiral avatar on the left:
```tsx
import { Avatar } from './star-command/Avatar'

// In the assistant message render (around line 65):
<div className="flex justify-start gap-2">
  <Avatar type="admiral" variant="speaking" size={28} />
  <div className="max-w-[80%] px-3 py-2 rounded-lg bg-neutral-800 text-neutral-100 text-sm whitespace-pre-wrap">
    {msg.content}
  </div>
</div>
```

**StatusPanel** — Add crew avatar next to each crew entry. Use `crew.avatar_variant` from the store (the `CrewStatus` type at line 13-21 already has `avatar_variant`):
```tsx
// In the crew list map (around line 97):
<div className="flex items-center gap-2">
  <Avatar type="crew" variant={crew.avatar_variant ?? undefined} size={20} />
  <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
  <span className="text-xs text-neutral-200 truncate font-mono">{crew.id}</span>
</div>
```

**Welcome screen** — Replace the star emoji with Admiral avatar:
```tsx
// Around line 349:
<Avatar type="admiral" variant="standby" size={64} />
```

**Streaming indicator** — Use `admiralAvatarState` from store for the streaming bubble avatar:
```tsx
const { admiralAvatarState } = useStarCommandStore()

// In the streamBuffer render (around line 360):
<div className="flex justify-start gap-2">
  <Avatar type="admiral" variant={admiralAvatarState} size={28} />
  <div className="max-w-[80%] ...">
    {streamBuffer}
    <span className="inline-block w-1.5 h-4 bg-neutral-400 ml-0.5 animate-pulse" />
  </div>
</div>
```

- [ ] **Step 4: Verify visually**

Run: `npm run dev`
- Welcome screen shows Admiral portrait (standby)
- Send a message — Admiral avatar cycles: thinking → speaking → standby
- Status panel shows crew avatars
- Chat messages have Admiral avatar on the left

- [ ] **Step 5: Note on avatar_variant**

The `avatar_variant` field on crew records is populated by backend code in the starbase module when deploying crew. If crew members all show the same default avatar (hoodie), it means the backend needs to assign a random variant from `['hoodie', 'headphones', 'robot', 'cap', 'glasses']` during `starbase.deploy()`. This is outside the scope of this visual polish plan — the frontend code correctly reads and uses whatever `avatar_variant` value is provided.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/star-command/Avatar.tsx src/renderer/src/components/StarCommandTab.tsx src/renderer/src/store/star-command-store.ts
git commit -m "feat(star-command): add avatar portraits to chat and status panel"
```

---

## Task 9: Shuttle Dock/Undock Animator

Add shuttle sprite animations that play when crew members are deployed or complete their missions.

**Files:**
- Create: `src/renderer/src/components/visualizer/shuttle-anim.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create ShuttleAnimator class**

```typescript
import { drawScSprite, isScSpriteReady } from '../star-command/sc-sprite-loader'

type ShuttleAnim = {
  crewId: string
  type: 'dock' | 'undock'
  startX: number
  startY: number
  endX: number
  endY: number
  elapsed: number
  duration: number  // total ms
  delay: number     // random delay before animation starts
}

const DOCK_DURATION = 1500
const UNDOCK_DURATION = 1500

export class ShuttleAnimator {
  private anims: ShuttleAnim[] = []

  /** Queue a dock animation from a random edge to the target pod position */
  dock(crewId: string, podX: number, podY: number, canvasW: number, canvasH: number): void {
    // Pick a random edge point
    const edge = Math.random()
    let startX: number, startY: number
    if (edge < 0.25) { startX = -30; startY = Math.random() * canvasH }
    else if (edge < 0.5) { startX = canvasW + 30; startY = Math.random() * canvasH }
    else if (edge < 0.75) { startX = Math.random() * canvasW; startY = -30 }
    else { startX = Math.random() * canvasW; startY = canvasH + 30 }

    this.anims.push({
      crewId, type: 'dock',
      startX, startY, endX: podX, endY: podY,
      elapsed: 0, duration: DOCK_DURATION,
      delay: Math.random() * 200,
    })
  }

  /** Queue an undock animation from pod position to a random edge */
  undock(crewId: string, podX: number, podY: number, canvasW: number, canvasH: number): void {
    const edge = Math.random()
    let endX: number, endY: number
    if (edge < 0.25) { endX = -30; endY = Math.random() * canvasH }
    else if (edge < 0.5) { endX = canvasW + 30; endY = Math.random() * canvasH }
    else if (edge < 0.75) { endX = Math.random() * canvasW; endY = -30 }
    else { endX = Math.random() * canvasW; endY = canvasH + 30 }

    this.anims.push({
      crewId, type: 'undock',
      startX: podX, startY: podY, endX, endY,
      elapsed: 0, duration: UNDOCK_DURATION,
      delay: Math.random() * 200,
    })
  }

  hasActiveAnims(): boolean {
    return this.anims.length > 0
  }

  /** Get the current position of a shuttle by crewId (for particle triggers) */
  getShuttlePosition(crewId: string): { x: number; y: number } | null {
    const anim = this.anims.find((a) => a.crewId === crewId)
    if (!anim) return null
    const t = Math.max(0, Math.min(1, (anim.elapsed - anim.delay) / anim.duration))
    return {
      x: anim.startX + (anim.endX - anim.startX) * t,
      y: anim.startY + (anim.endY - anim.startY) * t,
    }
  }

  update(deltaMs: number): void {
    for (const anim of this.anims) {
      anim.elapsed += deltaMs
    }
    // Remove completed anims
    this.anims = this.anims.filter(
      (a) => a.elapsed - a.delay < a.duration
    )
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!isScSpriteReady() || this.anims.length === 0) return

    for (const anim of this.anims) {
      const activeTime = anim.elapsed - anim.delay
      if (activeTime < 0) continue  // Still in delay

      const t = Math.min(1, activeTime / anim.duration)
      // Ease-out for dock, ease-in for undock
      const eased = anim.type === 'dock'
        ? 1 - Math.pow(1 - t, 2)
        : t * t

      const x = anim.startX + (anim.endX - anim.startX) * eased
      const y = anim.startY + (anim.endY - anim.startY) * eased

      // Use thrust sprite during travel, idle when nearly arrived
      const spriteKey = t > 0.9 && anim.type === 'dock' ? 'shuttle-idle' : 'shuttle-thrust'
      drawScSprite(ctx, spriteKey, anim.elapsed, x - 12, y - 12, 24, 24)
    }
  }
}
```

- [ ] **Step 2: Integrate into SpaceCanvas**

In `src/renderer/src/components/visualizer/SpaceCanvas.tsx`:

Add imports (after line 18):
```typescript
import { ShuttleAnimator } from './shuttle-anim'
import { loadScSpriteSheet } from '../star-command/sc-sprite-loader'
```

Add ref (after line 170):
```typescript
const shuttleAnimRef = useRef(new ShuttleAnimator())
```

Add crew list diffing ref — uses a Map (id→status) so we can detect status transitions for particles:
```typescript
const prevCrewRef = useRef<Map<string, string>>(new Map())
const isInitialMount = useRef(true)
```

Add a useEffect to diff crew lists and trigger shuttle anims + particle effects (after line 201):
```typescript
useEffect(() => {
  if (isInitialMount.current) {
    // On initial mount, just record current crew — don't animate
    prevCrewRef.current = new Map(crewList.map((c) => [c.id, c.status]))
    isInitialMount.current = false
    return
  }

  const prev = prevCrewRef.current
  const canvas = activeCanvasRef.current
  const w = canvas?.clientWidth ?? 800
  const h = canvas?.clientHeight ?? 400
  const ringCX = w / 2
  const ringCY = h / 2

  for (const crew of crewList) {
    const prevStatus = prev.get(crew.id)

    // New crew (not in prev) → dock animation
    if (prevStatus === undefined && crew.status === 'active') {
      shuttleAnimRef.current.dock(crew.id, ringCX, ringCY, w, h)
    }

    // Status transition to 'complete' → undock animation
    if (crew.status === 'complete' && prevStatus !== undefined && prevStatus !== 'complete') {
      shuttleAnimRef.current.undock(crew.id, ringCX, ringCY, w, h)
    }

    // Status transition to 'error' → hull sparks
    if (crew.status === 'error' && prevStatus !== 'error') {
      particlesRef.current.playEffect('hull-spark', ringCX, ringCY)
    }

    // Status transition to 'lost' → gas vent
    if (crew.status === 'lost' && prevStatus !== 'lost') {
      particlesRef.current.playEffect('gas-vent', ringCX, ringCY)
    }
  }

  prevCrewRef.current = new Map(crewList.map((c) => [c.id, c.status]))
}, [crewList])
```

Load the SC sprite sheet in the mid-layer effect (add after `loadSpriteSheet()` at line 248):
```typescript
loadScSpriteSheet()
```

Register pod positions and hub for comms beams. Add this in the active loop, after `crewPods.render(ctx, ringCX, ringCY, stationRing)` at line 347 and before `commsBeams.update(deltaMs)`:

```typescript
// Register positions for comms beams so orbs know where to travel
commsBeams.clearPositions()
commsBeams.setPosition('admiral', ringCX, ringCY) // Hub = center
for (const pod of podStatesRef.current) {
  const sectorIdx = stationRing.getSectorIndex(pod.sectorId)
  if (sectorIdx < 0) continue
  const { start, end } = stationRing.getSectorArc(sectorIdx)
  // Approximate pod position on the ring arc (midpoint of sector arc)
  const midAngle = (start + end) / 2
  const podRadius = stationRing.getRadius() - 4
  commsBeams.setPosition(pod.crewId, ringCX + Math.cos(midAngle) * podRadius, ringCY + Math.sin(midAngle) * podRadius)
}
```

Add shuttle rendering in the active loop (after `commsBeams.render(ctx, ringCX, ringCY)` at line 349):
```typescript
const shuttle = shuttleAnimRef.current
shuttle.update(deltaMs)
shuttle.render(ctx)
```

- [ ] **Step 3: Verify visually**

Run: `npm run dev`
Deploy a crew member via the Admiral. A shuttle should animate from an edge toward the center. When crew completes, shuttle departs.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/visualizer/shuttle-anim.ts src/renderer/src/components/visualizer/SpaceCanvas.tsx
git commit -m "feat(star-command): add shuttle dock/undock animations"
```

---

## Task 10: Particle Effect System

Create the one-shot particle system for visual effects triggered by status changes and shuttle events.

**Files:**
- Create: `src/renderer/src/components/visualizer/sc-particles.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create ScParticleSystem**

```typescript
import { drawScSpriteFrame, isScSpriteReady, getScFrame } from '../star-command/sc-sprite-loader'
import { SC_SPRITE_ATLAS } from '../star-command/sc-sprite-atlas'

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  life: number      // remaining ms
  maxLife: number
  spriteKey: string
  elapsed: number
}

type EffectType = 'thruster' | 'dock-sparkle' | 'hull-spark' | 'gas-vent' | 'explosion'

const EFFECT_CONFIG: Record<EffectType, {
  spriteKey: string
  count: [number, number]  // [min, max]
  life: number             // ms
  speed: number            // px/s
  spread: number           // radians
}> = {
  thruster:      { spriteKey: 'thruster-flame', count: [8, 12], life: 500, speed: 60, spread: Math.PI / 3 },
  'dock-sparkle': { spriteKey: 'dock-sparkle', count: [6, 10], life: 800, speed: 40, spread: Math.PI * 2 },
  'hull-spark':   { spriteKey: 'spark',         count: [4, 8],  life: 600, speed: 80, spread: Math.PI * 2 },
  'gas-vent':     { spriteKey: 'gas-puff',      count: [5, 8],  life: 1200, speed: 20, spread: Math.PI / 2 },
  explosion:     { spriteKey: 'explosion',      count: [1, 1],  life: 400, speed: 0, spread: 0 },
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

export class ScParticleSystem {
  private particles: Particle[] = []

  playEffect(type: EffectType, x: number, y: number, direction?: number): void {
    const config = EFFECT_CONFIG[type]
    const count = Math.floor(randRange(config.count[0], config.count[1]))
    const baseAngle = direction ?? Math.random() * Math.PI * 2

    for (let i = 0; i < count; i++) {
      const angle = baseAngle + randRange(-config.spread / 2, config.spread / 2)
      const speed = config.speed * randRange(0.5, 1.5)
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: config.life * randRange(0.7, 1.3),
        maxLife: config.life,
        spriteKey: config.spriteKey,
        elapsed: 0,
      })
    }
  }

  hasActiveParticles(): boolean {
    return this.particles.length > 0
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000
    for (const p of this.particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.life -= deltaMs
      p.elapsed += deltaMs
      // Slow down over time
      p.vx *= 0.98
      p.vy *= 0.98
    }
    this.particles = this.particles.filter((p) => p.life > 0)
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!isScSpriteReady() || this.particles.length === 0) return

    ctx.save()
    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.maxLife)
      ctx.globalAlpha = alpha

      const region = SC_SPRITE_ATLAS[p.spriteKey]
      if (!region) continue

      const frame = getScFrame(region, p.elapsed)
      drawScSpriteFrame(ctx, p.spriteKey, frame, p.x - region.w / 2, p.y - region.h / 2)
    }
    ctx.restore()
  }
}
```

- [ ] **Step 2: Integrate into SpaceCanvas**

In `src/renderer/src/components/visualizer/SpaceCanvas.tsx`:

Add import (with the shuttle-anim import):
```typescript
import { ScParticleSystem } from './sc-particles'
```

Add ref (after shuttleAnimRef):
```typescript
const particlesRef = useRef(new ScParticleSystem())
```

Add particle rendering in the active loop (after shuttle.render):
```typescript
const particles = particlesRef.current
particles.update(deltaMs)
particles.render(ctx)
```

Note: Particle triggers for crew status transitions (error → hull-spark, lost → gas-vent) are already wired in Task 9's crew diff useEffect. The shuttle dock/undock thruster effects can be added later by calling `particlesRef.current.playEffect('thruster', x, y)` at the shuttle's start position — this is a refinement that can follow the initial integration.

- [ ] **Step 3: Verify visually**

Run: `npm run dev`
Trigger crew status changes. Sparks should appear on error, gas vents on lost.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/visualizer/sc-particles.ts src/renderer/src/components/visualizer/SpaceCanvas.tsx
git commit -m "feat(star-command): add one-shot particle effect system"
```

---

## Task 11: Pod Status Sprite Overlays

Enhance crew pods with sprite-based beacon and checkmark overlays.

**Files:**
- Modify: `src/renderer/src/components/visualizer/crew-pods.ts`

- [ ] **Step 1: Add sprite imports and overlay rendering**

In `src/renderer/src/components/visualizer/crew-pods.ts`:

Add imports at the top:
```typescript
import { drawScSprite, drawScSpriteFrame, isScSpriteReady, getScFrame } from '../star-command/sc-sprite-loader'
import { SC_SPRITE_ATLAS } from '../star-command/sc-sprite-atlas'
```

Add a `completedAt` map to track when pods entered complete state (for 2-second checkmark display):
```typescript
private completedAt = new Map<string, number>() // crewId → elapsed time when completed
```

In the `update` method, track completion timestamps:
```typescript
update(pods: PodState[], deltaMs: number): void {
  this.pods = pods
  this.elapsed += deltaMs

  // Track completion times for checkmark overlay
  for (const pod of pods) {
    if (pod.status === 'complete' && !this.completedAt.has(pod.crewId)) {
      this.completedAt.set(pod.crewId, this.elapsed)
    }
  }
  // Clean up old entries
  const currentIds = new Set(pods.map((p) => p.crewId))
  for (const id of this.completedAt.keys()) {
    if (!currentIds.has(id)) this.completedAt.delete(id)
  }
}
```

In the `render` method, after drawing the pod circle (after `ctx.fill()` at ~line 110), add sprite overlays:

```typescript
// Sprite overlays (only if SC sprites are loaded)
if (isScSpriteReady()) {
  if (pod.status === 'hailing') {
    // Beacon alternation: on/off every 500ms
    const beaconKey = Math.floor(this.elapsed / 500) % 2 === 0 ? 'beacon-on' : 'beacon-off'
    drawScSprite(ctx, beaconKey, 0, px - 6, py - POD_RADIUS - 14, 12, 12)
  } else if (pod.status === 'complete') {
    const completedTime = this.completedAt.get(pod.crewId) ?? this.elapsed
    const sinceComplete = this.elapsed - completedTime
    if (sinceComplete < 2000) {
      // Show checkmark hologram for 2 seconds
      const checkAlpha = sinceComplete < 1500 ? 1 : 1 - (sinceComplete - 1500) / 500
      ctx.globalAlpha = checkAlpha
      drawScSprite(ctx, 'checkmark-holo', 0, px - 8, py - POD_RADIUS - 18, 16, 16)
      ctx.globalAlpha = 1
    }
  }
}
```

- [ ] **Step 2: Verify visually**

Run: `npm run dev`
- Deploy crew, set one to hailing → beacon should flash above pod
- Complete a mission → checkmark hologram appears for 2 seconds then fades

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/visualizer/crew-pods.ts
git commit -m "feat(star-command): add sprite overlays to crew pods"
```

---

## Task 12: Data Orb Comms Visuals

Replace plain circle orbs with sprite-based data orbs and wire up beam triggers from comms events.

**Files:**
- Modify: `src/renderer/src/components/visualizer/comms-beams.ts`
- Modify: `src/renderer/src/store/star-command-store.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Add recentComms to the store**

In `src/renderer/src/store/star-command-store.ts`, add:

Type (after `SectorInfo`):
```typescript
export type CommsEvent = {
  id: number
  from_crew: string
  to_crew: string
  type: string
  created_at: string
}
```

Store field (after `unreadCount`):
```typescript
recentComms: CommsEvent[]
```

Action:
```typescript
addCommsEvent: (event: CommsEvent) => void
```

Implementation:
```typescript
recentComms: [],
addCommsEvent: (event) => set((state) => ({
  recentComms: [...state.recentComms.slice(-19), event],  // Keep last 20
})),
```

- [ ] **Step 2: Update CommsBeamRenderer for beam types and sprites**

In `src/renderer/src/components/visualizer/comms-beams.ts`:

Replace the `Beam` type:
```typescript
import { drawScSprite, isScSpriteReady } from '../star-command/sc-sprite-loader'

type BeamType = 'hailing' | 'directive' | 'cargo'

type Beam = {
  fromId: string
  toId: string
  beamType: BeamType
  progress: number
  alive: boolean
  elapsed: number
}

const BEAM_COLORS: Record<BeamType, string> = {
  hailing: '#14b8a6',
  directive: '#fbbf24',
  cargo: '#06b6d4',
}

const BEAM_SPRITES: Record<BeamType, string> = {
  hailing: 'orb-teal',
  directive: 'orb-amber',
  cargo: 'orb-cargo',
}
```

Update `addBeam`:
```typescript
addBeam(from: string, to: string, beamType: BeamType): void {
  this.beams.push({
    fromId: from,
    toId: to,
    beamType,
    progress: 0,
    alive: true,
    elapsed: 0,
  })
}
```

Update `update` to track elapsed:
```typescript
update(deltaMs: number): void {
  const step = deltaMs / BEAM_DURATION_MS
  for (const beam of this.beams) {
    if (!beam.alive) continue
    beam.progress += step
    beam.elapsed += deltaMs
    if (beam.progress >= 1) beam.alive = false
  }
  this.beams = this.beams.filter((b) => b.alive)
}
```

Update `render` to use sprites:
```typescript
render(ctx: CanvasRenderingContext2D, _centerX: number, _centerY: number): void {
  if (this.beams.length === 0) return

  ctx.save()
  for (const beam of this.beams) {
    const from = this.positions.get(beam.fromId)
    const to = this.positions.get(beam.toId)
    if (!from || !to) continue

    const t = beam.progress
    const color = BEAM_COLORS[beam.beamType]
    const spriteKey = BEAM_SPRITES[beam.beamType]

    // For cargo beams, use quadratic bezier
    let ox: number, oy: number
    if (beam.beamType === 'cargo') {
      const mx = (from.x + to.x) / 2
      const my = (from.y + to.y) / 2
      const dx = to.x - from.x
      const dy = to.y - from.y
      const cpx = mx - dy * 0.3
      const cpy = my + dx * 0.3
      ox = (1-t)*(1-t)*from.x + 2*(1-t)*t*cpx + t*t*to.x
      oy = (1-t)*(1-t)*from.y + 2*(1-t)*t*cpy + t*t*to.y
    } else {
      ox = from.x + (to.x - from.x) * t
      oy = from.y + (to.y - from.y) * t
    }

    // Trail line
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(ox, oy)
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.15
    ctx.lineWidth = 1
    ctx.stroke()

    // Sprite orb (with glow)
    if (isScSpriteReady()) {
      ctx.globalAlpha = 0.3
      const glowSize = beam.beamType === 'cargo' ? 24 : 18
      drawScSprite(ctx, spriteKey, beam.elapsed, ox - glowSize/2, oy - glowSize/2, glowSize, glowSize)
      ctx.globalAlpha = 0.9
      const orbSize = beam.beamType === 'cargo' ? 16 : 12
      drawScSprite(ctx, spriteKey, beam.elapsed, ox - orbSize/2, oy - orbSize/2, orbSize, orbSize)
    } else {
      // Fallback to circles
      ctx.beginPath()
      ctx.arc(ox, oy, ORB_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.globalAlpha = 0.9
      ctx.fill()
    }
  }
  ctx.restore()
}
```

- [ ] **Step 3: Wire beam triggers in SpaceCanvas**

In `src/renderer/src/components/visualizer/SpaceCanvas.tsx`:

Add `recentComms` to the store subscription (line 177):
```typescript
const { sectors, crewList, recentComms } = useStarCommandStore()
```

Add a ref to track the last processed comms event ID (not array length, since the store caps at 20 entries):
```typescript
const lastCommsIdRef = useRef(0)
```

Add a useEffect to trigger beams from new comms:
```typescript
useEffect(() => {
  const comms = commsBeamRef.current
  for (const event of recentComms) {
    if (event.id <= lastCommsIdRef.current) continue  // Already processed

    let beamType: 'hailing' | 'directive' | 'cargo'
    if (event.type === 'hailing' || event.type === 'status_update') {
      beamType = 'hailing'
    } else if (event.type === 'directive' || event.type === 'question') {
      beamType = 'directive'
    } else if (event.type === 'cargo_manifest') {
      beamType = 'cargo'
    } else {
      beamType = 'hailing' // default
    }
    comms.addBeam(event.from_crew, event.to_crew, beamType)
    lastCommsIdRef.current = event.id
  }
}, [recentComms])
```

- [ ] **Step 4: Verify visually**

Run: `npm run dev`
Trigger comms events (crew hailing, Admiral directives). Sprite orbs should travel between positions. Cargo transfers should follow curved paths.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/visualizer/comms-beams.ts src/renderer/src/store/star-command-store.ts src/renderer/src/components/visualizer/SpaceCanvas.tsx
git commit -m "feat(star-command): add sprite data orbs and comms beam wiring"
```

---

## Task 13: Final Integration & Cleanup

Ensure all pieces work together and clean up any issues.

- [ ] **Step 1: Run the dev server and test the full flow**

```bash
npm run dev
```

Test:
1. Star Command tab loads with CRT frame, status bar, scanlines
2. Deploy crew → shuttle docks, pod appears, chip appears in status bar
3. Crew hails → beacon flashes on pod, teal orb travels to hub
4. Admiral sends directive → amber orb travels to pod
5. Crew completes → checkmark hologram, shuttle undocks
6. Crew errors → sparks, red pod
7. Crew lost → gas vent particles
8. Avatars show in messages and status panel

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Fix any type errors.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Fix any lint issues.

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "fix(star-command): final integration cleanup for visual polish"
```
