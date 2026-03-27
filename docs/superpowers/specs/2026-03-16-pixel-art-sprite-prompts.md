# Pixel Art Sprite Prompts for Fleet Visualizer

**Date:** 2026-03-16
**Total sprites:** 125 frames
**Target:** Single 512x512 sprite sheet (`sprites.png`)

Every prompt below is ready to copy-paste directly into an AI image generator. The style prefix is already included.

---

## Parent Ship Hulls (32x32px each, 6 variants)

Each hull's base prompt is used as idle frame 1. The animation frames section below tells you how to modify the prompt for the remaining 12 frames per hull.

### Hull 1 — Arrow (sleek interceptor)

**Save as:** `sprites-raw/ships/parent-1-arrow-idle-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, top-down spaceship sprite, 32x32 pixels, sleek arrow-shaped interceptor with swept-back wings, cyan accent stripe along the fuselage, small bright cockpit window, twin rear engine nozzles glowing soft white, metallic silver-gray hull with blue-tinted panels, facing right

### Hull 2 — Dart (compact fighter)

**Save as:** `sprites-raw/ships/parent-2-dart-idle-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, top-down spaceship sprite, 32x32 pixels, compact dart-shaped fighter with short angular wings, orange accent stripe on dorsal ridge, triangular cockpit visor, single large rear thruster, dark gunmetal hull with warm orange panel details, facing right

### Hull 3 — Wedge (heavy cruiser)

**Save as:** `sprites-raw/ships/parent-3-wedge-idle-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, top-down spaceship sprite, 32x32 pixels, wide wedge-shaped heavy cruiser, thick armored hull, magenta accent lights along the sides, broad rectangular cockpit, dual exhaust ports, charcoal-gray hull with purple-tinted armor plates, facing right

### Hull 4 — Fighter (classic starfighter)

**Save as:** `sprites-raw/ships/parent-4-fighter-idle-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, top-down spaceship sprite, 32x32 pixels, classic X-wing style starfighter with four wing tips, green accent markings on wing edges, round cockpit bubble, quad small engine nozzles, light gray hull with emerald green trim details, facing right

### Hull 5 — Shuttle (transport vessel)

**Save as:** `sprites-raw/ships/parent-5-shuttle-idle-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, top-down spaceship sprite, 32x32 pixels, rounded shuttle transport vessel with stubby wings, yellow accent band around the midsection, wide panoramic cockpit, twin boxy rear thrusters, off-white hull with golden yellow panel accents, facing right

### Hull 6 — Phantom (stealth ship)

**Save as:** `sprites-raw/ships/parent-6-phantom-idle-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, top-down spaceship sprite, 32x32 pixels, angular stealth ship with sharp faceted surfaces, red accent line along the spine, narrow slit cockpit, hidden flush-mounted engines, matte black hull with crimson red edge highlights, facing right

---

## Subagent Ship Hulls (20x20px each, 2 variants)

### Subagent Hull 1 — Drone

**Save as:** `sprites-raw/ships/subagent-1-drone-idle-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, top-down spaceship sprite, 20x20 pixels, small autonomous drone ship, compact diamond shape, single central thruster, tiny sensor eye instead of cockpit, light blue-gray hull, minimal detail, simpler than a full ship, facing right

### Subagent Hull 2 — Scout

**Save as:** `sprites-raw/ships/subagent-2-scout-idle-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, top-down spaceship sprite, 20x20 pixels, small scout probe ship, elongated oval shape with tiny rear fins, single small engine glow, no cockpit just a sensor array dot, pale silver hull with a subtle teal stripe, facing right

---

## Ship Animation Frames

Generate these for **each hull variant** above (both parent and subagent). Replace `[HULL_PROMPT]` with the **full prompt** from the corresponding hull section above (it already includes the style prefix).

### Using Image Editing for Consistency

For animation frames, use the hull's **idle frame 1** as an input image. This ensures the ship design stays consistent across all frames. With the `infsh` CLI, pass the base image via the `images` array:

```bash
# Example: Generate Arrow thrust-1 using the idle-1 image as reference
infsh app run google/gemini-3-1-flash-image-preview --input '{
  "prompt": "Edit this spaceship sprite. Keep the exact same ship design, colors, and shape. Add engine nozzles blazing bright with visible flame pixels extending 3-4 pixels behind the ship, hull panels slightly brighter as if powered up. Transparent background, no background color.",
  "images": ["sprites-raw/ships/parent-1-arrow-idle-1.png"],
  "aspect_ratio": "1:1"
}'
```

> **Note:** Pass the idle-1 image as a JPEG (not PNG) to avoid infsh service errors — convert with `sharp('file.png').jpeg({quality:95}).toFile('file.jpg')` first.

> **Reuse uploaded files:** Once infsh uploads a file, the output JSON contains the uploaded URL (e.g. `https://cloud.inference.sh/app/files/u/.../file.png`). You can pass this URL directly in `images` for all subsequent frames instead of re-uploading the local file every time:
>
> ```bash
> # Upload once — note the URL from the output
> infsh app run google/gemini-3-1-flash-image-preview --input '{
>   "prompt": "...",
>   "images": ["sprites-raw/ships/parent-1-arrow-idle-1.jpg"]
> }'
> # → output.images[0] = "https://cloud.inference.sh/app/files/u/abc123/idle-1.png"
>
> # Reuse for all remaining frames
> infsh app run google/gemini-3-1-flash-image-preview --input '{
>   "prompt": "...",
>   "images": ["https://cloud.inference.sh/app/files/u/abc123/idle-1.png"]
> }'
> ```
>
> The uploaded URL stays valid for the session — no need to re-upload for every request.

For each animation frame below:

1. Use the corresponding hull's `idle-1.png` (converted to `.jpg`) as the input image — upload once and reuse the URL
2. Use the animation prompt as the edit instruction
3. Always include "Keep the exact same ship design, colors, and shape" in the prompt
4. Always include "Transparent background, no background color" in the prompt

This is especially important for **warp frames** where the ship progressively dissolves — starting from the actual ship image produces much more consistent results than generating from scratch.

### Filename Pattern

For parent ships: `sprites-raw/ships/parent-{N}-{name}-{anim}-{frame}.png`
For subagent ships: `sprites-raw/ships/subagent-{N}-{name}-{anim}-{frame}.png`

**Example for Hull 1 — Arrow:**
| Animation | Filenames |
|-----------|-----------|
| Idle | `parent-1-arrow-idle-1.png` (base), `parent-1-arrow-idle-2.png` |
| Thrust | `parent-1-arrow-thrust-1.png`, `parent-1-arrow-thrust-2.png`, `parent-1-arrow-thrust-3.png` |
| Warp-In | `parent-1-arrow-warp-in-1.png` through `parent-1-arrow-warp-in-4.png` |
| Warp-Out | `parent-1-arrow-warp-out-1.png` through `parent-1-arrow-warp-out-4.png` |

Repeat this pattern for all 8 hulls (6 parent + 2 subagent).

### Idle Frame 2 (subtle bob)

**Save as:** `{prefix}-idle-2.png`

> [HULL_PROMPT], slight vertical offset of 1 pixel downward compared to frame 1, engine nozzle glow slightly dimmer, subtle breathing animation frame

### Working/Thrust Frame 1

**Save as:** `{prefix}-thrust-1.png`

> [HULL_PROMPT], engine nozzles blazing bright with visible flame pixels extending 3-4 pixels behind the ship, hull panels slightly brighter as if powered up

### Working/Thrust Frame 2

**Save as:** `{prefix}-thrust-2.png`

> [HULL_PROMPT], engine flames at medium intensity extending 2-3 pixels behind, slight vibration offset of 1 pixel, energy crackling around thruster

### Working/Thrust Frame 3

**Save as:** `{prefix}-thrust-3.png`

> [HULL_PROMPT], engine flames at maximum flare extending 4-5 pixels behind with bright white core, hull accent lights at peak brightness

### Warp-In Frame 1

**Save as:** `{prefix}-warp-in-1.png`

> [HULL_PROMPT], ship barely visible as a thin horizontal streak of light, 4-5 pixels tall, mostly white-blue energy trail, ship not yet formed

### Warp-In Frame 2

**Save as:** `{prefix}-warp-in-2.png`

> [HULL_PROMPT], ship partially materialized from a streak, front half of ship visible but rear is still an energy trail, scanline distortion effect

### Warp-In Frame 3

**Save as:** `{prefix}-warp-in-3.png`

> [HULL_PROMPT], ship mostly materialized with faint energy wisps around edges, slight transparency/ghosting effect, nearly solid

### Warp-In Frame 4

**Save as:** `{prefix}-warp-in-4.png`

> [HULL_PROMPT], ship fully materialized with a brief bright flash halo around it, 1-2 pixel glow outline that will fade, arrival complete

### Warp-Out Frame 1

**Save as:** `{prefix}-warp-out-1.png`

> [HULL_PROMPT], ship fully visible but with motion blur pixels appearing behind it, beginning to stretch horizontally

### Warp-Out Frame 2

**Save as:** `{prefix}-warp-out-2.png`

> [HULL_PROMPT], ship stretching into a horizontal streak, front half still recognizable but rear dissolving into energy trail

### Warp-Out Frame 3

**Save as:** `{prefix}-warp-out-3.png`

> [HULL_PROMPT], mostly a horizontal energy streak with faint ship silhouette barely visible, bright white-blue trail

### Warp-Out Frame 4

**Save as:** `{prefix}-warp-out-4.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, fading horizontal streak of white-blue energy, no ship visible, just dissipating light trail pixels, [32x32 or 20x20] canvas mostly empty

---

## Asteroids (16x16px each, 3 variants x 2 rotation frames)

### Asteroid Variant 1 — Chunky (Frame 1)

**Save as:** `sprites-raw/asteroids/chunky-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, asteroid sprite, 16x16 pixels, chunky irregular rock, dark brown and gray with lighter tan highlights on edges, small crater indentations, jagged silhouette, space rock floating in void

### Asteroid Variant 1 — Chunky (Frame 2)

**Save as:** `sprites-raw/asteroids/chunky-2.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, same chunky asteroid rotated roughly 15-20 degrees, slightly different face visible, dark brown and gray with lighter tan highlights, 16x16 pixels

### Asteroid Variant 2 — Smooth (Frame 1)

**Save as:** `sprites-raw/asteroids/smooth-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, asteroid sprite, 16x16 pixels, smoother rounded space rock, dark slate gray with subtle blue-ish mineral veins, one small bright crystal inclusion, rounder silhouette than typical asteroid

### Asteroid Variant 2 — Smooth (Frame 2)

**Save as:** `sprites-raw/asteroids/smooth-2.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, same smooth rounded asteroid rotated roughly 15-20 degrees, different angle showing more of the crystal vein, dark slate gray, 16x16 pixels

### Asteroid Variant 3 — Jagged (Frame 1)

**Save as:** `sprites-raw/asteroids/jagged-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, asteroid sprite, 16x16 pixels, jagged sharp-edged space debris, very angular and broken looking, dark charcoal with reddish-iron oxide patches, looks like a fragment of a larger body

### Asteroid Variant 3 — Jagged (Frame 2)

**Save as:** `sprites-raw/asteroids/jagged-2.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, same jagged asteroid fragment rotated roughly 15-20 degrees, showing different sharp edges, dark charcoal with reddish-iron oxide patches, 16x16 pixels

---

## Celestial Bodies

### Planet 1 — Gas Giant (32x32px)

**Save as:** `sprites-raw/celestials/gas-giant.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, planet sprite, 32x32 pixels, gas giant with horizontal atmospheric bands in deep blue and purple hues, subtle lighter swirl suggesting a storm, thin bright atmosphere edge highlight, no rings

### Planet 2 — Rocky World (32x32px)

**Save as:** `sprites-raw/celestials/rocky-world.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, planet sprite, 32x32 pixels, small rocky terrestrial planet, rusty red-orange and tan surface with darker crater shadows, thin pale atmosphere line on the lit edge, half in shadow with crisp terminator line

### Moon (16x16px)

**Save as:** `sprites-raw/celestials/moon.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, moon sprite, 16x16 pixels, small gray cratered moon, cool gray tones with lighter highland regions, 3-4 visible small craters as darker circles, subtle shadow on one side, simple and iconic

### Space Station (48x48px)

**Save as:** `sprites-raw/celestials/space-station.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, space station sprite, 48x48 pixels, orbital station with a central hub and two solar panel wings extending left and right, small antenna array on top, tiny blinking red light pixel, metallic gray and white with blue solar panel segments, viewed from above

---

## Shooting Star (16x4px)

**Save as:** `sprites-raw/effects/shooting-star.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, shooting star sprite, 16x4 pixels, horizontal meteor streak, bright white head pixel on the right fading to yellow then orange then dim red trail on the left, 1 pixel tall core with 1 pixel glow above and below at the bright end

---

## Particles

### Engine Trail Puff — Frame 1 (4x4px)

**Save as:** `sprites-raw/particles/engine-puff-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, tiny particle sprite, 4x4 pixels, small bright engine exhaust puff, bright white-yellow center pixel with orange outer pixels, fully opaque

### Engine Trail Puff — Frame 2 (4x4px)

**Save as:** `sprites-raw/particles/engine-puff-2.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, tiny particle sprite, 4x4 pixels, expanding exhaust puff, orange center with dim red-orange outer pixels, slightly faded

### Engine Trail Puff — Frame 3 (4x4px)

**Save as:** `sprites-raw/particles/engine-puff-3.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, tiny particle sprite, 4x4 pixels, fading exhaust wisp, very dim dark red-gray, only 2-3 pixels still visible, nearly dissipated

### Warp Streak — Frame 1 (8x2px)

**Save as:** `sprites-raw/particles/warp-streak-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, warp streak sprite, 8x2 pixels, horizontal energy streak, bright white-cyan on the right fading to blue on the left, crisp 2 pixel height

### Warp Streak — Frame 2 (8x2px)

**Save as:** `sprites-raw/particles/warp-streak-2.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, warp streak sprite, 8x2 pixels, fading horizontal energy streak, dim cyan-blue fading to near invisible, thinner and dimmer than frame 1

### Spawn Burst — Frame 1 (8x8px)

**Save as:** `sprites-raw/particles/spawn-burst-1.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, burst effect sprite, 8x8 pixels, bright flash of white-cyan energy, dense cluster of bright pixels in center, start of an explosion or materialization

### Spawn Burst — Frame 2 (8x8px)

**Save as:** `sprites-raw/particles/spawn-burst-2.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, burst effect sprite, 8x8 pixels, expanding ring of cyan-blue energy pixels, center starting to clear, 4-5 pixel radius ring pattern

### Spawn Burst — Frame 3 (8x8px)

**Save as:** `sprites-raw/particles/spawn-burst-3.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, burst effect sprite, 8x8 pixels, larger fading ring of blue energy pixels, sparse scattered pixels, ring mostly dissolved

### Spawn Burst — Frame 4 (8x8px)

**Save as:** `sprites-raw/particles/spawn-burst-4.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, burst effect sprite, 8x8 pixels, nearly gone, just 2-3 faint dim blue pixels scattered, almost fully dissipated

---

## Bloom Glow (16x16px)

**Save as:** `sprites-raw/effects/bloom-glow.png`

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, glow sprite, 16x16 pixels, soft circular radial glow, brightest white pixel in dead center fading through light blue to transparent edges, smooth circular falloff using only 4-5 brightness levels, no hard edge, meant to be drawn with additive blending behind ships

---

## Complete File Checklist

Run `npx tsx scripts/assemble-sprites.ts` to validate. All 125 files listed below:

### Ships (104 files)

```
sprites-raw/ships/parent-1-arrow-idle-1.png
sprites-raw/ships/parent-1-arrow-idle-2.png
sprites-raw/ships/parent-1-arrow-thrust-1.png
sprites-raw/ships/parent-1-arrow-thrust-2.png
sprites-raw/ships/parent-1-arrow-thrust-3.png
sprites-raw/ships/parent-1-arrow-warp-in-1.png
sprites-raw/ships/parent-1-arrow-warp-in-2.png
sprites-raw/ships/parent-1-arrow-warp-in-3.png
sprites-raw/ships/parent-1-arrow-warp-in-4.png
sprites-raw/ships/parent-1-arrow-warp-out-1.png
sprites-raw/ships/parent-1-arrow-warp-out-2.png
sprites-raw/ships/parent-1-arrow-warp-out-3.png
sprites-raw/ships/parent-1-arrow-warp-out-4.png
sprites-raw/ships/parent-2-dart-idle-1.png
sprites-raw/ships/parent-2-dart-idle-2.png
sprites-raw/ships/parent-2-dart-thrust-1.png
sprites-raw/ships/parent-2-dart-thrust-2.png
sprites-raw/ships/parent-2-dart-thrust-3.png
sprites-raw/ships/parent-2-dart-warp-in-1.png
sprites-raw/ships/parent-2-dart-warp-in-2.png
sprites-raw/ships/parent-2-dart-warp-in-3.png
sprites-raw/ships/parent-2-dart-warp-in-4.png
sprites-raw/ships/parent-2-dart-warp-out-1.png
sprites-raw/ships/parent-2-dart-warp-out-2.png
sprites-raw/ships/parent-2-dart-warp-out-3.png
sprites-raw/ships/parent-2-dart-warp-out-4.png
sprites-raw/ships/parent-3-wedge-idle-1.png
sprites-raw/ships/parent-3-wedge-idle-2.png
sprites-raw/ships/parent-3-wedge-thrust-1.png
sprites-raw/ships/parent-3-wedge-thrust-2.png
sprites-raw/ships/parent-3-wedge-thrust-3.png
sprites-raw/ships/parent-3-wedge-warp-in-1.png
sprites-raw/ships/parent-3-wedge-warp-in-2.png
sprites-raw/ships/parent-3-wedge-warp-in-3.png
sprites-raw/ships/parent-3-wedge-warp-in-4.png
sprites-raw/ships/parent-3-wedge-warp-out-1.png
sprites-raw/ships/parent-3-wedge-warp-out-2.png
sprites-raw/ships/parent-3-wedge-warp-out-3.png
sprites-raw/ships/parent-3-wedge-warp-out-4.png
sprites-raw/ships/parent-4-fighter-idle-1.png
sprites-raw/ships/parent-4-fighter-idle-2.png
sprites-raw/ships/parent-4-fighter-thrust-1.png
sprites-raw/ships/parent-4-fighter-thrust-2.png
sprites-raw/ships/parent-4-fighter-thrust-3.png
sprites-raw/ships/parent-4-fighter-warp-in-1.png
sprites-raw/ships/parent-4-fighter-warp-in-2.png
sprites-raw/ships/parent-4-fighter-warp-in-3.png
sprites-raw/ships/parent-4-fighter-warp-in-4.png
sprites-raw/ships/parent-4-fighter-warp-out-1.png
sprites-raw/ships/parent-4-fighter-warp-out-2.png
sprites-raw/ships/parent-4-fighter-warp-out-3.png
sprites-raw/ships/parent-4-fighter-warp-out-4.png
sprites-raw/ships/parent-5-shuttle-idle-1.png
sprites-raw/ships/parent-5-shuttle-idle-2.png
sprites-raw/ships/parent-5-shuttle-thrust-1.png
sprites-raw/ships/parent-5-shuttle-thrust-2.png
sprites-raw/ships/parent-5-shuttle-thrust-3.png
sprites-raw/ships/parent-5-shuttle-warp-in-1.png
sprites-raw/ships/parent-5-shuttle-warp-in-2.png
sprites-raw/ships/parent-5-shuttle-warp-in-3.png
sprites-raw/ships/parent-5-shuttle-warp-in-4.png
sprites-raw/ships/parent-5-shuttle-warp-out-1.png
sprites-raw/ships/parent-5-shuttle-warp-out-2.png
sprites-raw/ships/parent-5-shuttle-warp-out-3.png
sprites-raw/ships/parent-5-shuttle-warp-out-4.png
sprites-raw/ships/parent-6-phantom-idle-1.png
sprites-raw/ships/parent-6-phantom-idle-2.png
sprites-raw/ships/parent-6-phantom-thrust-1.png
sprites-raw/ships/parent-6-phantom-thrust-2.png
sprites-raw/ships/parent-6-phantom-thrust-3.png
sprites-raw/ships/parent-6-phantom-warp-in-1.png
sprites-raw/ships/parent-6-phantom-warp-in-2.png
sprites-raw/ships/parent-6-phantom-warp-in-3.png
sprites-raw/ships/parent-6-phantom-warp-in-4.png
sprites-raw/ships/parent-6-phantom-warp-out-1.png
sprites-raw/ships/parent-6-phantom-warp-out-2.png
sprites-raw/ships/parent-6-phantom-warp-out-3.png
sprites-raw/ships/parent-6-phantom-warp-out-4.png
sprites-raw/ships/subagent-1-drone-idle-1.png
sprites-raw/ships/subagent-1-drone-idle-2.png
sprites-raw/ships/subagent-1-drone-thrust-1.png
sprites-raw/ships/subagent-1-drone-thrust-2.png
sprites-raw/ships/subagent-1-drone-thrust-3.png
sprites-raw/ships/subagent-1-drone-warp-in-1.png
sprites-raw/ships/subagent-1-drone-warp-in-2.png
sprites-raw/ships/subagent-1-drone-warp-in-3.png
sprites-raw/ships/subagent-1-drone-warp-in-4.png
sprites-raw/ships/subagent-1-drone-warp-out-1.png
sprites-raw/ships/subagent-1-drone-warp-out-2.png
sprites-raw/ships/subagent-1-drone-warp-out-3.png
sprites-raw/ships/subagent-1-drone-warp-out-4.png
sprites-raw/ships/subagent-2-scout-idle-1.png
sprites-raw/ships/subagent-2-scout-idle-2.png
sprites-raw/ships/subagent-2-scout-thrust-1.png
sprites-raw/ships/subagent-2-scout-thrust-2.png
sprites-raw/ships/subagent-2-scout-thrust-3.png
sprites-raw/ships/subagent-2-scout-warp-in-1.png
sprites-raw/ships/subagent-2-scout-warp-in-2.png
sprites-raw/ships/subagent-2-scout-warp-in-3.png
sprites-raw/ships/subagent-2-scout-warp-in-4.png
sprites-raw/ships/subagent-2-scout-warp-out-1.png
sprites-raw/ships/subagent-2-scout-warp-out-2.png
sprites-raw/ships/subagent-2-scout-warp-out-3.png
sprites-raw/ships/subagent-2-scout-warp-out-4.png
```

### Asteroids (6 files)

```
sprites-raw/asteroids/chunky-1.png
sprites-raw/asteroids/chunky-2.png
sprites-raw/asteroids/smooth-1.png
sprites-raw/asteroids/smooth-2.png
sprites-raw/asteroids/jagged-1.png
sprites-raw/asteroids/jagged-2.png
```

### Celestials (4 files)

```
sprites-raw/celestials/gas-giant.png
sprites-raw/celestials/rocky-world.png
sprites-raw/celestials/moon.png
sprites-raw/celestials/space-station.png
```

### Particles (9 files)

```
sprites-raw/particles/engine-puff-1.png
sprites-raw/particles/engine-puff-2.png
sprites-raw/particles/engine-puff-3.png
sprites-raw/particles/warp-streak-1.png
sprites-raw/particles/warp-streak-2.png
sprites-raw/particles/spawn-burst-1.png
sprites-raw/particles/spawn-burst-2.png
sprites-raw/particles/spawn-burst-3.png
sprites-raw/particles/spawn-burst-4.png
```

### Effects (2 files)

```
sprites-raw/effects/shooting-star.png
sprites-raw/effects/bloom-glow.png
```

---

## Assembly

Once all 125 files are in place, run:

```bash
npx tsx scripts/assemble-sprites.ts
```

This will:

1. Validate all files exist
2. Resize to exact pixel dimensions (nearest-neighbor)
3. Check for transparency issues
4. Pack into 512x512 sprite sheet
5. Generate the TypeScript atlas config

**Output:**

- `src/renderer/src/assets/sprites.png`
- `src/renderer/src/components/visualizer/sprite-atlas.ts`
