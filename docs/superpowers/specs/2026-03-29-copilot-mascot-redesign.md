# Copilot Mascot Redesign — Design Spec

Replace the current copilot character sprite with a new "Nebula Pup" mascot generated via PixelLab's pixel art API.

## Character Design

**Nebula Pup** — a small, chibi-proportioned four-legged alien creature. Dog-like but clearly extraterrestrial.

- **Body:** Purple/magenta nebula-patterned coat, chubby round body
- **Features:** Big floppy ears, large expressive eyes, stubby legs
- **Accents:** Warm orange/gold bioluminescent glow on tail tip, ear tips, and eyes
- **Proportions:** Chibi (PixelLab preset) — oversized head, tiny body for readability at small sizes
- **Outline:** Single-color outline for crisp pixel art readability
- **Body type:** Quadruped, using PixelLab's `dog` template
- **Vibe:** Cute, friendly, approachable

## Animation States & Sprite Sheet

Single horizontal PNG strip, 128x128px per frame. Same format as current `copilot-sprites.png`.

| State | Frames | FPS | Behavior | PixelLab Approach |
|-------|--------|-----|----------|-------------------|
| Idle | 0, 1 | 2 | Sleeping/resting, gentle tail glow pulse | `animate_character` idle template — "sleeping curled up" |
| Processing | 2, 3, 4 | 4 | Alert, ears perked, tail wagging | `animate_character` walking/idle template — "excited, ears up, wagging tail" |
| Permission | 5, 6 | 3 | Pawing/looking up expectantly | Separate character pose fallback — "looking up, one paw raised" |
| Complete | 7, 8 | 2 | Happy celebration bounce | `animate_character` — "happy jump/bounce" |

**Total: 9 frames** — matches current sprite sheet exactly.

## PixelLab Generation Sequence

1. `create_character` — nebula pup, quadruped/dog, chibi proportions, front-facing, purple/magenta body with orange/gold glowing accents
2. Verify the generated design looks good
3. `animate_character` — idle animation (sleeping/resting)
4. `animate_character` — processing animation (excited/tail wag)
5. `animate_character` — complete animation (happy bounce)
6. Permission state: attempt animation, fall back to separate character pose if needed
7. Extract frames and assemble into a single 1152x128px horizontal sprite strip (9 frames x 128px)

## PixelLab Parameters

```
create_character:
  description: "A cute chibi alien dog creature with purple and magenta nebula-patterned fur coat, big floppy ears, large expressive eyes, stubby legs, chubby round body, warm orange and gold bioluminescent glow on tail tip, ear tips, and eyes, extraterrestrial space pet"
  body_type: quadruped
  template: dog
  proportions: chibi
  outline: single color
  n_directions: 1
  size: 128
```

## Integration

**Files changed:**
- `src/renderer/copilot/src/assets/copilot-sprites.png` — replaced with new sprite sheet
- `src/renderer/copilot/src/assets/copilot-sprites.ts` — regenerated base64 data URI

**No changes to:**
- `SpaceshipSprite.tsx` — frame count, sizes, animation config all stay identical
- CSS animations (bob, thrust, pulse-amber, flash-green)
- Any component logic

## Color Palette

- **Primary body:** Purple/magenta (#8B3FA0 range) with nebula swirl patterns
- **Glow accents:** Warm orange/gold (#FFB347, #FFA500 range) on tail tip, ear tips, eyes
- **Contrast rationale:** Warm tones pop against Fleet's dark UI with teal/cyan accents
