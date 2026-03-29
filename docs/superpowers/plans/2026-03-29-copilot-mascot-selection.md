# Copilot Mascot Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to choose from different animated mascot sprites in the copilot settings UI.

**Architecture:** Add a `MascotDefinition` type and `MASCOT_REGISTRY` to shared code. Create a sprite loader that maps mascot IDs to base64-encoded sprite sheet data. Replace the placeholder sprite section in copilot settings with a visual card grid. Update `SpaceshipSprite` to read the selected mascot from settings.

**Tech Stack:** TypeScript, React, Zustand, Tailwind CSS, Vitest

---

### Task 1: Add MascotDefinition Type and Registry

**Files:**
- Modify: `src/shared/types.ts:165-170`
- Modify: `src/shared/constants.ts:69-74`

- [ ] **Step 1: Add the MascotDefinition type**

In `src/shared/types.ts`, add the type after the `CopilotSettings` type (after line 170):

```typescript
export type MascotDefinition = {
  id: string;
  name: string;
  description: string;
  thumbnailFrame: number;
};
```

- [ ] **Step 2: Add MASCOT_REGISTRY and update default spriteSheet**

In `src/shared/constants.ts`, add the import for `MascotDefinition` and the registry. Change the import line:

```typescript
import type { FleetSettings, MascotDefinition } from './types';
```

Add the registry before `DEFAULT_SETTINGS`:

```typescript
export const MASCOT_REGISTRY: MascotDefinition[] = [
  { id: 'spaceship', name: 'Spaceship', description: 'The classic Fleet vessel', thumbnailFrame: 0 },
  { id: 'robot', name: 'Robot', description: 'A friendly automaton', thumbnailFrame: 0 },
  { id: 'cat', name: 'Cat', description: 'A curious space cat', thumbnailFrame: 0 },
];
```

Update the default `spriteSheet` value in `DEFAULT_SETTINGS.copilot`:

```typescript
copilot: {
  enabled: false,
  spriteSheet: 'spaceship',
  notificationSound: 'Pop',
  autoStart: false,
},
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat(copilot): add MascotDefinition type and MASCOT_REGISTRY"
```

---

### Task 2: Create Sprite Assets and Loader

**Files:**
- Create: `src/renderer/copilot/src/assets/sprites-spaceship.ts`
- Create: `src/renderer/copilot/src/assets/sprites-robot.ts`
- Create: `src/renderer/copilot/src/assets/sprites-cat.ts`
- Create: `src/renderer/copilot/src/assets/sprite-loader.ts`
- Delete: `src/renderer/copilot/src/assets/copilot-sprites.ts`

- [ ] **Step 1: Create sprites-spaceship.ts by copying the existing sprite sheet**

Copy `src/renderer/copilot/src/assets/copilot-sprites.ts` to `src/renderer/copilot/src/assets/sprites-spaceship.ts`. The file content is identical — it exports a base64 data URL string as the default export.

```bash
cp src/renderer/copilot/src/assets/copilot-sprites.ts src/renderer/copilot/src/assets/sprites-spaceship.ts
```

- [ ] **Step 2: Create placeholder sprite sheets for robot and cat**

For now, create `sprites-robot.ts` and `sprites-cat.ts` that re-export the spaceship sprite as placeholders (the actual pixel art will be generated separately via PixelLab or created manually):

`src/renderer/copilot/src/assets/sprites-robot.ts`:
```typescript
// Placeholder: re-exports spaceship sprite until robot sprite sheet is created
// Replace this default export with a base64 data URL of the robot sprite sheet
// Format: 9 frames at 128px each (1152×128px), same state mapping as spaceship
export { default } from './sprites-spaceship';
```

`src/renderer/copilot/src/assets/sprites-cat.ts`:
```typescript
// Placeholder: re-exports spaceship sprite until cat sprite sheet is created
// Replace this default export with a base64 data URL of the cat sprite sheet
// Format: 9 frames at 128px each (1152×128px), same state mapping as spaceship
export { default } from './sprites-spaceship';
```

- [ ] **Step 3: Create sprite-loader.ts**

`src/renderer/copilot/src/assets/sprite-loader.ts`:
```typescript
import spaceship from './sprites-spaceship';
import robot from './sprites-robot';
import cat from './sprites-cat';

const SPRITE_SHEETS: Record<string, string> = { spaceship, robot, cat };

export function getSpriteSheet(id: string): string {
  return SPRITE_SHEETS[id] ?? SPRITE_SHEETS['spaceship'];
}
```

- [ ] **Step 4: Delete old copilot-sprites.ts**

```bash
rm src/renderer/copilot/src/assets/copilot-sprites.ts
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: FAIL — `SpaceshipSprite.tsx` still imports from `copilot-sprites` which no longer exists. This is expected and will be fixed in Task 3.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/copilot/src/assets/sprites-spaceship.ts \
        src/renderer/copilot/src/assets/sprites-robot.ts \
        src/renderer/copilot/src/assets/sprites-cat.ts \
        src/renderer/copilot/src/assets/sprite-loader.ts
git rm src/renderer/copilot/src/assets/copilot-sprites.ts
git commit -m "feat(copilot): add sprite sheet assets and loader module"
```

---

### Task 3: Update SpaceshipSprite to Use Sprite Loader

**Files:**
- Modify: `src/renderer/copilot/src/components/SpaceshipSprite.tsx`

- [ ] **Step 1: Update SpaceshipSprite to read mascot from settings and use the loader**

Replace the hardcoded sprite import with the loader. The component needs to read `settings.spriteSheet` from the copilot store and pass it to `getSpriteSheet()`.

In `src/renderer/copilot/src/components/SpaceshipSprite.tsx`:

Replace:
```typescript
import spriteSheet from '../assets/copilot-sprites';
```

With:
```typescript
import { getSpriteSheet } from '../assets/sprite-loader';
```

Add a settings read inside the `SpaceshipSprite` component (alongside the existing `useCopilotStore` call):
```typescript
const settings = useCopilotStore((s) => s.settings);
const spriteSheet = getSpriteSheet(settings?.spriteSheet ?? 'spaceship');
```

No other changes needed — `spriteSheet` is already used in the JSX `backgroundImage` style.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/SpaceshipSprite.tsx
git commit -m "feat(copilot): use sprite loader for dynamic mascot selection"
```

---

### Task 4: Build Mascot Selection Grid in Settings UI

**Files:**
- Modify: `src/renderer/copilot/src/components/CopilotSettings.tsx`

- [ ] **Step 1: Replace the sprite placeholder with a mascot selection grid**

In `src/renderer/copilot/src/components/CopilotSettings.tsx`:

Add imports at the top:
```typescript
import { MASCOT_REGISTRY } from '../../../../shared/constants';
import { getSpriteSheet } from '../assets/sprite-loader';
```

Replace the placeholder sprite section (lines 82-90):
```tsx
{/* Sprite */}
<div>
  <label className="text-[10px] text-neutral-400 block mb-1">
    Sprite
  </label>
  <div className="text-[10px] text-neutral-500">
    Default spaceship (more sprites coming soon)
  </div>
</div>
```

With the mascot selection grid:
```tsx
{/* Mascot */}
<div>
  <label className="text-[10px] text-neutral-400 block mb-1">
    Mascot
  </label>
  <div className="flex gap-2">
    {MASCOT_REGISTRY.map((mascot) => {
      const isSelected = (settings?.spriteSheet ?? 'spaceship') === mascot.id;
      const sheet = getSpriteSheet(mascot.id);
      return (
        <button
          key={mascot.id}
          onClick={() => updateSettings({ spriteSheet: mascot.id })}
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
              backgroundPosition: `-${mascot.thumbnailFrame * 128 * (48 / 128)}px 0`,
              backgroundSize: `${128 * 9 * (48 / 128)}px ${48}px`,
              backgroundRepeat: 'no-repeat',
              imageRendering: 'pixelated',
            }}
          />
          <span className="text-[10px] text-neutral-300">{mascot.name}</span>
        </button>
      );
    })}
  </div>
</div>
```

The thumbnail scaling works by using the ratio `48 / 128` (display size / sprite size) to scale the background. For `thumbnailFrame: 0`, `backgroundPosition` is `0px 0` which shows the first idle frame.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Manual verification**

Run: `npm run dev`
1. Open the copilot window
2. Navigate to Settings
3. Verify the mascot grid shows 3 cards (Spaceship, Robot, Cat)
4. Verify clicking a card updates the selection highlight
5. Verify the copilot sprite changes to match the selected mascot
6. Close and reopen — verify the selection persists

- [ ] **Step 5: Commit**

```bash
git add src/renderer/copilot/src/components/CopilotSettings.tsx
git commit -m "feat(copilot): add mascot selection grid to settings UI"
```

---

### Task 5: Build and Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: PASS — no existing tests should break

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS — clean build with no errors
