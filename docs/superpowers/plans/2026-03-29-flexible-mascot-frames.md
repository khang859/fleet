# Flexible Mascot Sprite Frames — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support variable frame counts per mascot sprite sheet for smoother animations, while preserving backward compatibility with existing 9-frame mascots.

**Architecture:** Add `SpriteAnimation` and `SpriteAnimations` types to shared types. Each mascot optionally declares its own frame map; when omitted, a `DEFAULT_ANIMATIONS` constant provides the legacy 9-frame layout. All consumers derive total frame count from the animation metadata instead of hardcoding `9`.

**Tech Stack:** TypeScript, React, sharp (assembly script)

---

### File Map

| File | Action | Responsibility |
|---|---|---|
| `src/shared/types.ts` | Modify | Add `SpriteAnimation`, `SpriteAnimations` types; extend `MascotDefinition` |
| `src/shared/mascots.ts` | Modify | Export `DEFAULT_ANIMATIONS`; add helper `getMascotAnimations()` |
| `src/renderer/copilot/src/components/SpaceshipSprite.tsx` | Modify | Use registry animations instead of hardcoded constant; dynamic frame count |
| `src/renderer/copilot/src/components/MascotPicker.tsx` | Modify | Dynamic frame count for thumbnail background sizing |
| `scripts/assemble-copilot-sprites.ts` | Modify | Remove `TOTAL_FRAMES = 9` cap; accept variable frame count |

---

### Task 1: Add sprite animation types

**Files:**
- Modify: `src/shared/types.ts:172-177`

- [ ] **Step 1: Add SpriteAnimation and SpriteAnimations types**

In `src/shared/types.ts`, add the new types directly above the existing `MascotDefinition` type:

```ts
export type SpriteAnimation = {
  frames: number[];
  fps: number;
};

export type SpriteAnimations = Record<'idle' | 'processing' | 'permission' | 'complete', SpriteAnimation>;
```

- [ ] **Step 2: Extend MascotDefinition with optional animations field**

Replace the existing `MascotDefinition` type in `src/shared/types.ts`:

```ts
export type MascotDefinition = {
  id: string;
  name: string;
  description: string;
  thumbnailFrame: number;
  animations?: SpriteAnimations;
};
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — the new field is optional so all existing usage compiles.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(mascots): add SpriteAnimation types and optional animations field to MascotDefinition"
```

---

### Task 2: Export DEFAULT_ANIMATIONS and helper from mascots registry

**Files:**
- Modify: `src/shared/mascots.ts`

- [ ] **Step 1: Add DEFAULT_ANIMATIONS and getMascotAnimations helper**

In `src/shared/mascots.ts`, add the import for the new type and the constant + helper after the registry:

```ts
import type { MascotDefinition, SpriteAnimations } from './types';

export const MASCOT_REGISTRY: MascotDefinition[] = [
  { id: 'officer', name: 'Officer', description: 'The classic Fleet officer', thumbnailFrame: 0 },
  { id: 'robot', name: 'Robot', description: 'A friendly automaton', thumbnailFrame: 0 },
  { id: 'cat', name: 'Cat', description: 'A curious space cat', thumbnailFrame: 0 },
  { id: 'bear', name: 'Bear', description: 'An armored polar bear warrior', thumbnailFrame: 0 },
  { id: 'kraken', name: 'Kraken', description: 'An astral space kraken', thumbnailFrame: 0 },
];

export const DEFAULT_ANIMATIONS: SpriteAnimations = {
  idle: { frames: [0, 1], fps: 2 },
  processing: { frames: [2, 3, 4], fps: 4 },
  permission: { frames: [5, 6], fps: 3 },
  complete: { frames: [7, 8], fps: 2 },
};

/** Resolve a mascot's animations, falling back to the legacy 9-frame layout. */
export function getMascotAnimations(mascotId: string): SpriteAnimations {
  const mascot = MASCOT_REGISTRY.find((m) => m.id === mascotId);
  return mascot?.animations ?? DEFAULT_ANIMATIONS;
}

/** Derive total frame count from a SpriteAnimations definition. */
export function getTotalFrames(animations: SpriteAnimations): number {
  return Math.max(...Object.values(animations).flatMap((a) => a.frames)) + 1;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/mascots.ts
git commit -m "feat(mascots): add DEFAULT_ANIMATIONS, getMascotAnimations, and getTotalFrames helpers"
```

---

### Task 3: Update SpaceshipSprite to use registry animations

**Files:**
- Modify: `src/renderer/copilot/src/components/SpaceshipSprite.tsx`

- [ ] **Step 1: Replace hardcoded SPRITE_ANIMATIONS with registry lookup**

Replace the imports and constants at the top of `SpaceshipSprite.tsx`:

```ts
import React, { useRef, useCallback, useState, useEffect } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { getSpriteSheet } from '../assets/sprite-loader';
import { getMascotAnimations, getTotalFrames } from '../../../../shared/mascots';
import type { SpriteAnimations } from '../../../../shared/types';

const SPRITE_SIZE = 128;
const DRAG_THRESHOLD = 4;

type SpriteState = 'idle' | 'processing' | 'permission' | 'complete';
```

Remove the entire `SPRITE_ANIMATIONS` constant (lines 12-17 in current file).

- [ ] **Step 2: Update useSpriteAnimation to accept animations parameter**

Replace the `useSpriteAnimation` function:

```ts
function useSpriteAnimation(state: SpriteState, animations: SpriteAnimations): number {
  const frameRef = useRef(0);
  const timerRef = useRef(0);
  const [, forceRender] = useState(0);
  const prevState = useRef(state);

  if (prevState.current !== state) {
    prevState.current = state;
    frameRef.current = 0;
  }

  useEffect(() => {
    const anim = animations[state];
    const interval = 1000 / anim.fps;
    timerRef.current = window.setInterval(() => {
      frameRef.current = (frameRef.current + 1) % anim.frames.length;
      forceRender((n) => n + 1);
    }, interval);
    return () => window.clearInterval(timerRef.current);
  }, [state, animations]);

  const anim = animations[state];
  return anim.frames[frameRef.current % anim.frames.length];
}
```

- [ ] **Step 3: Update SpaceshipSprite component to use dynamic frame count**

In the `SpaceshipSprite` component function, resolve the mascot animations and derive frame count:

```ts
export function SpaceshipSprite(): React.JSX.Element {
  const spriteState = useSpriteState();
  const settings = useCopilotStore((s) => s.settings);
  const mascotId = settings?.spriteSheet ?? 'officer';
  const animations = getMascotAnimations(mascotId);
  const frameIndex = useSpriteAnimation(spriteState, animations);
  const toggleExpanded = useCopilotStore((s) => s.toggleExpanded);
  const spriteSheet = getSpriteSheet(mascotId);
  const totalFrames = getTotalFrames(animations);

  const wasDragged = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const windowStartPos = useRef({ x: 0, y: 0 });

  // ... handleMouseDown and handleClick unchanged ...

  const animationClass = {
    idle: 'animate-bob',
    processing: 'animate-thrust',
    permission: 'animate-pulse-amber',
    complete: 'animate-flash-green',
  }[spriteState];

  return (
    <div
      className={`cursor-pointer select-none ${animationClass}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      style={{
        width: SPRITE_SIZE,
        height: SPRITE_SIZE,
        backgroundImage: `url(${spriteSheet})`,
        backgroundPosition: `-${frameIndex * SPRITE_SIZE}px 0`,
        backgroundSize: `${SPRITE_SIZE * totalFrames}px ${SPRITE_SIZE}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
      }}
    />
  );
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/copilot/src/components/SpaceshipSprite.tsx
git commit -m "feat(mascots): use registry-based animations in SpaceshipSprite"
```

---

### Task 4: Update MascotPicker thumbnail sizing

**Files:**
- Modify: `src/renderer/copilot/src/components/MascotPicker.tsx`

- [ ] **Step 1: Import helpers and use dynamic frame count**

Add the import at the top of `MascotPicker.tsx`:

```ts
import { MASCOT_REGISTRY, getTotalFrames, DEFAULT_ANIMATIONS } from '../../../../shared/mascots';
```

- [ ] **Step 2: Replace hardcoded `128 * 9` with dynamic calculation**

Inside the `.map()` callback, derive totalFrames per mascot:

```ts
{MASCOT_REGISTRY.map((mascot) => {
  const isSelected = (settings?.spriteSheet ?? 'officer') === mascot.id;
  const sheet = getSpriteSheet(mascot.id);
  const totalFrames = getTotalFrames(mascot.animations ?? DEFAULT_ANIMATIONS);
  const scale = 48 / 128;
  return (
    <button
      key={mascot.id}
      onClick={() => void updateSettings({ spriteSheet: mascot.id })}
      className={`flex flex-col items-center gap-1 p-1.5 rounded border transition-colors ${
        isSelected
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-neutral-700 hover:border-neutral-500'
      }`}
    >
      <div
        style={{
          width: 48,
          height: 48,
          backgroundImage: `url(${sheet})`,
          backgroundPosition: `-${mascot.thumbnailFrame * 128 * scale}px 0`,
          backgroundSize: `${128 * totalFrames * scale}px ${48}px`,
          backgroundRepeat: 'no-repeat',
          imageRendering: 'pixelated',
        }}
      />
      <span className="text-[10px] text-neutral-300">{mascot.name}</span>
    </button>
  );
})}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/copilot/src/components/MascotPicker.tsx
git commit -m "feat(mascots): dynamic frame count in MascotPicker thumbnails"
```

---

### Task 5: Update assembly script for variable frame count

**Files:**
- Modify: `scripts/assemble-copilot-sprites.ts`

- [ ] **Step 1: Remove TOTAL_FRAMES constant and accept variable input**

Replace the script with the following (full file since most lines change):

```ts
import sharp from 'sharp';
import { writeFile, readdir, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Assemble Copilot Mascot Sprite Sheet
// ---------------------------------------------------------------------------
//
// Takes N input images (any size, transparent or not) and assembles them into
// a single horizontal sprite strip at 128x128px per frame. Outputs a lossless
// WebP file to resources/mascots/.
//
// Usage:
//   npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <image1> <image2> ... <imageN>
//   npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <directory>
//
// Output:
//   resources/mascots/<mascot-id>.webp

const __dirname = dirname(fileURLToPath(import.meta.url));

const FRAME_SIZE = 128;
const MASCOTS_DIR = join(__dirname, '..', 'resources', 'mascots');

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      'Usage: npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <img1> ... <imgN>'
    );
    console.error('   or: npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <directory>');
    process.exit(1);
  }

  const mascotId = args[0];
  let imagePaths: string[];

  if (args.length === 2) {
    // Single arg after mascot-id: treat as directory, read images sorted by name
    const dir = args[1];
    const files = (await readdir(dir)).filter((f) => /\.(png|webp|jpg|jpeg)$/i.test(f)).sort();
    if (files.length === 0) {
      console.error(`Directory ${dir} has no image files`);
      process.exit(1);
    }
    imagePaths = files.map((f) => join(dir, f));
  } else {
    // Explicit image paths
    imagePaths = args.slice(1);
  }

  if (imagePaths.length < 2) {
    console.error('Need at least 2 frames for a sprite sheet');
    process.exit(1);
  }

  // Verify all images exist
  for (const p of imagePaths) {
    try {
      await access(p);
    } catch {
      console.error(`File not found: ${p}`);
      process.exit(1);
    }
  }

  const totalFrames = imagePaths.length;
  console.log(`Assembling ${totalFrames} frames for mascot "${mascotId}"...`);

  // Resize each frame to FRAME_SIZE x FRAME_SIZE
  const resizedBuffers: Buffer[] = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const buf = await sharp(imagePaths[i])
      .resize(FRAME_SIZE, FRAME_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();
    resizedBuffers.push(buf);
    console.log(`  Frame ${i}: ${imagePaths[i]}`);
  }

  // Compose into horizontal strip
  const composites = resizedBuffers.map((buf, i) => ({
    input: buf,
    left: i * FRAME_SIZE,
    top: 0
  }));

  const sheet = await sharp({
    create: {
      width: FRAME_SIZE * totalFrames,
      height: FRAME_SIZE,
      channels: 4 as const,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .webp({ lossless: true })
    .toBuffer();

  // Write WebP
  await mkdir(MASCOTS_DIR, { recursive: true });
  const webpPath = join(MASCOTS_DIR, `${mascotId}.webp`);
  await writeFile(webpPath, sheet);
  console.log(
    `\nSprite sheet: ${webpPath} (${FRAME_SIZE * totalFrames}x${FRAME_SIZE}px, ${Math.round(sheet.length / 1024)}KB)`
  );
  console.log('\nDone! Remember to add an entry to MASCOT_REGISTRY in src/shared/mascots.ts');
  console.log(`  If using more than 9 frames, include an animations field in the registry entry.`);
}

void main();
```

- [ ] **Step 2: Commit**

```bash
git add scripts/assemble-copilot-sprites.ts
git commit -m "feat(mascots): allow variable frame count in sprite assembly script"
```

---

### Task 6: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the mascot sprite documentation**

Update the "Copilot Mascot Sprites" section in `CLAUDE.md` to reflect the new flexible format:

Replace:
> Each mascot is a 9-frame horizontal WebP sprite sheet (1152×128px) stored in `resources/mascots/`. Frame layout: `idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)`.

With:
> Each mascot is a horizontal WebP sprite sheet stored in `resources/mascots/` at 128×128px per frame. Legacy mascots use 9 frames (1152×128px) with the default layout: `idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)`. New mascots can have any number of frames — define a custom `animations` field in the mascot registry entry (see `src/shared/mascots.ts`). Recommended 16-frame layout: `idle(0-3) processing(4-9) permission(10,11) complete(12-15)`.

Update the assembly script usage note:
> This outputs `resources/mascots/<mascot-id>.webp`. Then register the mascot in `src/shared/mascots.ts`. For mascots with more than 9 frames, include an `animations` field mapping each state to its frame indices and FPS.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for flexible mascot frame counts"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS — builds successfully with all changes.
