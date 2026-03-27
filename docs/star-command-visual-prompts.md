# Star Command Visual Asset Prompts

**Total sprites:** 60 images → 1 sprite sheet (`star-command-sprites.png`)

## Generation Workflow

1. Generate each image one at a time using `scripts/generate-image.ts`
2. Review each output — regenerate with adjusted prompts if needed
3. For variants, use `--reference` to the base image for style consistency
4. When all images are generated in `sprites-staging/star-command/`:
   - Run `npx tsx scripts/remove-background.ts` to strip backgrounds → `sprites-raw/star-command/`
   - Run `npx tsx scripts/assemble-star-command-sprites.ts` to assemble the sheet

## Style Prefix

All prompts use this consistent prefix:

> Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels,

**Color palette:** deep navy (#0a0e1a), teal (#14b8a6), cyan (#06b6d4), amber (#fbbf24), soft red (#ef4444), white (#ffffff)

## Reference Chain Strategy

Each category has a **base image** generated via text-to-image. All variants in that category use `--reference` to the base for style consistency.

```
Admiral:   admiral-default → (edit) → speaking, thinking, alert, standby
Crew:      crew-hoodie → (edit) → headphones, robot, cap, glasses
CRT:       crt-corner-tl → (edit) → tr, bl, br, edge-h, edge-v, scanline
StatusBar: statusbar-tile → (edit) → rivet, divider
Chips:     chip-frame → (edit) → all 6 dots
Shuttle:   shuttle-idle → (edit) → thrust-1, thrust-2, thrust-3
Particles: spark-1 → (edit) → spark-2; gas-puff-1 → (edit) → 2, 3; explosion-1 → (edit) → 2, 3, 4; dock-sparkle-1 → (edit) → 2, 3; thruster-flame-1 → (edit) → 2, 3
Orbs:      orb-teal → (edit) → orb-amber, orb-cargo
Beacon:    beacon-on → (edit) → beacon-off
Checkmark: standalone (text-to-image)
Station:   station-hub-1 → (edit) → 2, 3, 4, 5, 6, 7, 8 (rotation frames)
```

---

## 1. Admiral Avatars (64x64)

### admiral-default (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, 64x64 pixel art portrait, sci-fi commander character, front-facing bust, long dark navy coat with high collar, teal glowing headset over one ear, confident expression, short dark hair, subtle teal circuit-trace details on collar, deep navy background fading to transparent" --output star-command/avatars/admiral-default.png
```

### admiral-speaking (EDIT from default)

```bash
npx tsx scripts/generate-image.ts "Same character, mouth slightly open speaking, headset glowing brighter teal, slightly more animated expression, everything else identical" --output star-command/avatars/admiral-speaking.png --reference star-command/avatars/admiral-default.png
```

### admiral-thinking (EDIT from default)

```bash
npx tsx scripts/generate-image.ts "Same character, eyes closed in contemplation, one hand near chin, headset glow dimmed to faint teal, thoughtful expression, everything else identical" --output star-command/avatars/admiral-thinking.png --reference star-command/avatars/admiral-default.png
```

### admiral-alert (EDIT from default)

```bash
npx tsx scripts/generate-image.ts "Same character, eyes wide and alert, headset flashing amber-orange instead of teal, urgent expression, slight amber glow on face from headset, everything else identical" --output star-command/avatars/admiral-alert.png --reference star-command/avatars/admiral-default.png
```

### admiral-standby (EDIT from default)

```bash
npx tsx scripts/generate-image.ts "Same character, relaxed neutral expression, headset glow very dim barely visible, calm standby pose, slightly softer lighting, everything else identical" --output star-command/avatars/admiral-standby.png --reference star-command/avatars/admiral-default.png
```

---

## 2. Crew Avatars (64x64)

### crew-hoodie (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, 64x64 pixel art portrait, developer character wearing a dark hoodie pulled up slightly, front-facing bust, laptop screen glow reflecting on face in teal, casual relaxed expression, soft ambient lighting, sci-fi space station setting implied" --output star-command/avatars/crew-hoodie.png
```

### crew-headphones (EDIT from crew-hoodie)

```bash
npx tsx scripts/generate-image.ts "Same art style, 64x64 pixel art portrait, different developer character wearing large over-ear headphones with visible cyan waveform pattern on the ear cups, no hoodie, t-shirt, focused expression, similar lighting and composition" --output star-command/avatars/crew-headphones.png --reference star-command/avatars/crew-hoodie.png
```

### crew-robot (EDIT from crew-hoodie)

```bash
npx tsx scripts/generate-image.ts "Same art style, 64x64 pixel art portrait, robot crewmate character, metallic head with a small antenna on top, horizontal visor eyes glowing teal, no human features, friendly rounded robot design, similar lighting and composition" --output star-command/avatars/crew-robot.png --reference star-command/avatars/crew-hoodie.png
```

### crew-cap (EDIT from crew-hoodie)

```bash
npx tsx scripts/generate-image.ts "Same art style, 64x64 pixel art portrait, developer character wearing a baseball cap slightly tilted, casual confident expression, no hoodie, plain jacket, similar lighting and composition" --output star-command/avatars/crew-cap.png --reference star-command/avatars/crew-hoodie.png
```

### crew-glasses (EDIT from crew-hoodie)

```bash
npx tsx scripts/generate-image.ts "Same art style, 64x64 pixel art portrait, developer character wearing round glasses, focused studious expression, no hoodie, collared shirt, light reflecting off the round glass lenses, similar lighting and composition" --output star-command/avatars/crew-glasses.png --reference star-command/avatars/crew-hoodie.png
```

---

## 3. CRT Frame Pieces

### crt-corner-tl (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, transparent background, no anti-aliasing, sharp pixels, 32x32 pixel art, top-left corner piece of a CRT monitor bezel, rounded outer corner, dark charcoal plastic with subtle sheen highlight on the edge, inner edge has a slight bevel, retro monitor frame aesthetic, dark color scheme" --output star-command/chrome/crt-corner-tl.png
```

### crt-corner-tr (EDIT from crt-corner-tl)

```bash
npx tsx scripts/generate-image.ts "Same CRT bezel corner piece, horizontally mirrored to be a top-right corner, identical style and materials" --output star-command/chrome/crt-corner-tr.png --reference star-command/chrome/crt-corner-tl.png
```

### crt-corner-bl (EDIT from crt-corner-tl)

```bash
npx tsx scripts/generate-image.ts "Same CRT bezel corner piece, vertically mirrored to be a bottom-left corner, identical style and materials" --output star-command/chrome/crt-corner-bl.png --reference star-command/chrome/crt-corner-tl.png
```

### crt-corner-br (EDIT from crt-corner-tl)

```bash
npx tsx scripts/generate-image.ts "Same CRT bezel corner piece, rotated 180 degrees to be a bottom-right corner, identical style and materials" --output star-command/chrome/crt-corner-br.png --reference star-command/chrome/crt-corner-tl.png
```

### crt-edge-h (EDIT from crt-corner-tl)

```bash
npx tsx scripts/generate-image.ts "Same art style, 32x8 pixel art, horizontal edge tile for a CRT monitor bezel, seamlessly tileable left-to-right, dark charcoal plastic with subtle sheen, flat straight section of the bezel frame, no corner rounding" --output star-command/chrome/crt-edge-h.png --reference star-command/chrome/crt-corner-tl.png
```

### crt-edge-v (EDIT from crt-corner-tl)

```bash
npx tsx scripts/generate-image.ts "Same art style, 8x32 pixel art, vertical edge tile for a CRT monitor bezel, seamlessly tileable top-to-bottom, dark charcoal plastic with subtle sheen, flat straight section of the bezel frame, no corner rounding" --output star-command/chrome/crt-edge-v.png --reference star-command/chrome/crt-corner-tl.png
```

### crt-scanline (EDIT from crt-corner-tl)

```bash
npx tsx scripts/generate-image.ts "Same art style, 4x4 pixel art, tiny seamlessly tileable scanline overlay pattern, alternating rows of very faint horizontal lines, barely visible subtle CRT screen effect, mostly transparent with hint of dark lines" --output star-command/chrome/crt-scanline.png --reference star-command/chrome/crt-corner-tl.png
```

---

## 4. Status Bar

### statusbar-tile (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, transparent background, no anti-aliasing, sharp pixels, 64x24 pixel art, seamlessly tileable dark brushed metal texture, horizontal brushed steel look, very dark gunmetal gray, subtle directional brush marks, sci-fi control panel bar aesthetic" --output star-command/chrome/statusbar-tile.png
```

### statusbar-rivet (EDIT from statusbar-tile)

```bash
npx tsx scripts/generate-image.ts "Same art style, 8x8 pixel art, single small metal rivet or bolt head, dark gunmetal with a tiny bright highlight on top, circular, flush with surface, industrial sci-fi look" --output star-command/chrome/statusbar-rivet.png --reference star-command/chrome/statusbar-tile.png
```

### statusbar-divider (EDIT from statusbar-tile)

```bash
npx tsx scripts/generate-image.ts "Same art style, 4x24 pixel art, thin vertical divider groove in dark metal, subtle shadow on left side and tiny highlight on right side, recessed groove in a metal panel" --output star-command/chrome/statusbar-divider.png --reference star-command/chrome/statusbar-tile.png
```

---

## 5. Status Chips

### chip-frame (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, transparent background, no anti-aliasing, sharp pixels, 48x20 pixel art, rounded rectangle badge frame, dark navy background with very subtle teal border glow, soft inner bevel, sci-fi HUD element, status badge shape" --output star-command/chrome/chip-frame.png
```

### chip-dot-active (EDIT from chip-frame)

```bash
npx tsx scripts/generate-image.ts "Same art style, 8x8 pixel art, small glowing circle dot, bright teal color (#14b8a6), subtle glow around it, status indicator light" --output star-command/chrome/chip-dot-active.png --reference star-command/chrome/chip-frame.png
```

### chip-dot-hailing (EDIT from chip-dot-active)

```bash
npx tsx scripts/generate-image.ts "Same small glowing circle dot, amber-yellow color (#fbbf24) instead of teal, same size and glow style" --output star-command/chrome/chip-dot-hailing.png --reference star-command/chrome/chip-dot-active.png
```

### chip-dot-error (EDIT from chip-dot-active)

```bash
npx tsx scripts/generate-image.ts "Same small glowing circle dot, soft red color (#ef4444) instead of teal, same size and glow style" --output star-command/chrome/chip-dot-error.png --reference star-command/chrome/chip-dot-active.png
```

### chip-dot-complete (EDIT from chip-dot-active)

```bash
npx tsx scripts/generate-image.ts "Same small glowing circle dot, bright green color (#22c55e) instead of teal, same size and glow style" --output star-command/chrome/chip-dot-complete.png --reference star-command/chrome/chip-dot-active.png
```

### chip-dot-idle (EDIT from chip-dot-active)

```bash
npx tsx scripts/generate-image.ts "Same small circle dot, dim muted teal color (#0d9488), very faint glow, low energy standby look" --output star-command/chrome/chip-dot-idle.png --reference star-command/chrome/chip-dot-active.png
```

### chip-dot-lost (EDIT from chip-dot-active)

```bash
npx tsx scripts/generate-image.ts "Same small circle dot, gray color (#6b7280), no glow, inactive dead indicator" --output star-command/chrome/chip-dot-lost.png --reference star-command/chrome/chip-dot-active.png
```

---

## 6. Shuttle

### shuttle-idle (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, 24x24 pixel art, small sci-fi shuttle spacecraft side view, compact rounded body, small wings, engines off and dark, teal accent stripe, light gray hull, facing right, parked/docked pose" --output star-command/shuttle/shuttle-idle.png
```

### shuttle-thrust-1 (EDIT from shuttle-idle)

```bash
npx tsx scripts/generate-image.ts "Same shuttle, engines firing with small bright flame coming from rear thrusters, blue-white engine glow, flame is small just starting, ship facing right in motion" --output star-command/shuttle/shuttle-thrust-1.png --reference star-command/shuttle/shuttle-idle.png
```

### shuttle-thrust-2 (EDIT from shuttle-idle)

```bash
npx tsx scripts/generate-image.ts "Same shuttle, engines firing with medium bright flame from rear thrusters, blue-white engine glow, flame is medium size, ship facing right in motion, slightly different flame shape than frame 1" --output star-command/shuttle/shuttle-thrust-2.png --reference star-command/shuttle/shuttle-idle.png
```

### shuttle-thrust-3 (EDIT from shuttle-idle)

```bash
npx tsx scripts/generate-image.ts "Same shuttle, engines firing with large bright flame from rear thrusters, blue-white engine glow, flame is at maximum size, ship facing right in motion, different flame shape than previous frames" --output star-command/shuttle/shuttle-thrust-3.png --reference star-command/shuttle/shuttle-idle.png
```

---

## 7. Particle Sprites

### spark-1 (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style, clean lines, transparent background, no anti-aliasing, sharp pixels, 8x8 pixel art, tiny bright white-yellow spark, 4-pointed star shape, bright center fading to edges, electrical spark effect, very small" --output star-command/particles/spark-1.png
```

### spark-2 (EDIT from spark-1)

```bash
npx tsx scripts/generate-image.ts "Same tiny spark, slightly different shape, more elongated or rotated, same brightness and color, variation of the spark" --output star-command/particles/spark-2.png --reference star-command/particles/spark-1.png
```

### gas-puff-1 (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style, clean lines, transparent background, no anti-aliasing, sharp pixels, 12x12 pixel art, small cloud of venting gas, wispy gray-white puff, early stage of gas vent, compact shape, semi-transparent look" --output star-command/particles/gas-puff-1.png
```

### gas-puff-2 (EDIT from gas-puff-1)

```bash
npx tsx scripts/generate-image.ts "Same gas puff cloud, slightly more expanded and dispersed, mid-stage of venting, more spread out, same wispy style" --output star-command/particles/gas-puff-2.png --reference star-command/particles/gas-puff-1.png
```

### gas-puff-3 (EDIT from gas-puff-1)

```bash
npx tsx scripts/generate-image.ts "Same gas puff cloud, very dispersed and fading, final stage of venting, most spread out, barely visible wispy remnants" --output star-command/particles/gas-puff-3.png --reference star-command/particles/gas-puff-1.png
```

### explosion-1 (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style, clean lines, transparent background, no anti-aliasing, sharp pixels, 16x16 pixel art, small explosion first frame, bright white-yellow center, compact initial burst, orange-red edges, beginning of explosion" --output star-command/particles/explosion-1.png
```

### explosion-2 (EDIT from explosion-1)

```bash
npx tsx scripts/generate-image.ts "Same explosion, second frame, expanding outward, more orange and red, larger blast radius, bright center shrinking" --output star-command/particles/explosion-2.png --reference star-command/particles/explosion-1.png
```

### explosion-3 (EDIT from explosion-1)

```bash
npx tsx scripts/generate-image.ts "Same explosion, third frame, mostly dissipated, dark red and smoke, large radius, center gone dark, fading embers" --output star-command/particles/explosion-3.png --reference star-command/particles/explosion-1.png
```

### explosion-4 (EDIT from explosion-1)

```bash
npx tsx scripts/generate-image.ts "Same explosion, final frame, almost gone, faint dark smoke wisps, very faded, barely visible remnants" --output star-command/particles/explosion-4.png --reference star-command/particles/explosion-1.png
```

### dock-sparkle-1 (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style, clean lines, transparent background, no anti-aliasing, sharp pixels, 8x8 pixel art, tiny bright sparkle effect, teal-white color, small cross or star shape, docking connection sparkle, bright and crisp" --output star-command/particles/dock-sparkle-1.png
```

### dock-sparkle-2 (EDIT from dock-sparkle-1)

```bash
npx tsx scripts/generate-image.ts "Same sparkle, slightly expanded, more points of light, mid-animation, same teal-white color" --output star-command/particles/dock-sparkle-2.png --reference star-command/particles/dock-sparkle-1.png
```

### dock-sparkle-3 (EDIT from dock-sparkle-1)

```bash
npx tsx scripts/generate-image.ts "Same sparkle, fading out, dimmer, dispersing points, final animation frame, barely visible" --output star-command/particles/dock-sparkle-3.png --reference star-command/particles/dock-sparkle-1.png
```

### thruster-flame-1 (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style, clean lines, transparent background, no anti-aliasing, sharp pixels, 8x12 pixel art, small rocket thruster flame, pointing downward, bright blue-white core at top, transitioning to orange at the tip, narrow flame shape, first frame of animation" --output star-command/particles/thruster-flame-1.png
```

### thruster-flame-2 (EDIT from thruster-flame-1)

```bash
npx tsx scripts/generate-image.ts "Same thruster flame, slightly different shape, flame flickering wider in the middle, same colors, second frame variation" --output star-command/particles/thruster-flame-2.png --reference star-command/particles/thruster-flame-1.png
```

### thruster-flame-3 (EDIT from thruster-flame-1)

```bash
npx tsx scripts/generate-image.ts "Same thruster flame, another shape variation, flame narrower and taller, same colors, third frame variation" --output star-command/particles/thruster-flame-3.png --reference star-command/particles/thruster-flame-1.png
```

### checkmark-holo (standalone — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style, clean lines, transparent background, no anti-aliasing, sharp pixels, 16x16 pixel art, holographic checkmark symbol, bright green (#22c55e) with a subtle cyan glow aura, crisp check shape, sci-fi hologram look, slightly translucent feel" --output star-command/particles/checkmark-holo.png
```

---

## 8. Data Orbs

### orb-teal (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style, clean lines, transparent background, no anti-aliasing, sharp pixels, 12x12 pixel art, small glowing data orb, bright teal color (#14b8a6), circular with soft glow aura, energy sphere, sci-fi data packet, bright center fading to glow at edges" --output star-command/orbs/orb-teal.png
```

### orb-amber (EDIT from orb-teal)

```bash
npx tsx scripts/generate-image.ts "Same glowing data orb, amber-yellow color (#fbbf24) instead of teal, same size shape and glow style" --output star-command/orbs/orb-amber.png --reference star-command/orbs/orb-teal.png
```

### orb-cargo (EDIT from orb-teal)

```bash
npx tsx scripts/generate-image.ts "Same style glowing orb but larger 16x16, teal-to-cyan gradient color, slightly more detailed with inner pattern suggesting cargo/data contents, brighter glow" --output star-command/orbs/orb-cargo.png --reference star-command/orbs/orb-teal.png
```

---

## 9. Beacon

### beacon-on (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style, clean lines, transparent background, no anti-aliasing, sharp pixels, 12x12 pixel art, small warning beacon light, amber-orange (#fbbf24) color, lit and glowing brightly, dome-shaped beacon on a tiny base, light rays emanating, alert signal" --output star-command/beacon/beacon-on.png
```

### beacon-off (EDIT from beacon-on)

```bash
npx tsx scripts/generate-image.ts "Same beacon, light is off, dark gray dome with no glow, no light rays, unlit inactive version, same shape and base" --output star-command/beacon/beacon-off.png --reference star-command/beacon/beacon-on.png
```

---

---

## 10. Space Station Hub (64x64 per frame, 8 frames)

The central hub module of the Starbase. This is the visual centerpiece rendered inside SpaceCanvas — a slowly rotating pixel art space station core. Each frame is a 22.5° rotation step for a full 360° cycle.

### station-hub-1 (BASE — text-to-image)

```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, modern pixel art style like Celeste and Hyper Light Drifter, clean lines, vibrant colors, transparent background, dark space game aesthetic, no anti-aliasing, sharp pixels, 64x64 pixel art, top-down view of a sci-fi space station central hub module, circular core with a bright teal glowing reactor in the center, 4 docking arms extending outward at cardinal directions, small solar panel wings on each arm, teal-lit windows dotting the structure, dark gunmetal metal plating, subtle teal ambient glow emanating from center, rotation frame 1 of 8 (0 degrees)" --output star-command/station/station-hub-1.png
```

### station-hub-2 (EDIT from station-hub-1)

```bash
npx tsx scripts/generate-image.ts "Same space station hub, rotated 45 degrees clockwise, everything else identical — same art style, same colors, same structure" --output star-command/station/station-hub-2.png --reference star-command/station/station-hub-1.png
```

### station-hub-3 (EDIT from station-hub-1)

```bash
npx tsx scripts/generate-image.ts "Same space station hub, rotated 90 degrees clockwise from the original, docking arms now pointing diagonally, everything else identical" --output star-command/station/station-hub-3.png --reference star-command/station/station-hub-1.png
```

### station-hub-4 (EDIT from station-hub-1)

```bash
npx tsx scripts/generate-image.ts "Same space station hub, rotated 135 degrees clockwise from the original, everything else identical" --output star-command/station/station-hub-4.png --reference star-command/station/station-hub-1.png
```

### station-hub-5 (EDIT from station-hub-1)

```bash
npx tsx scripts/generate-image.ts "Same space station hub, rotated 180 degrees from the original (upside down), everything else identical" --output star-command/station/station-hub-5.png --reference star-command/station/station-hub-1.png
```

### station-hub-6 (EDIT from station-hub-1)

```bash
npx tsx scripts/generate-image.ts "Same space station hub, rotated 225 degrees clockwise from the original, everything else identical" --output star-command/station/station-hub-6.png --reference star-command/station/station-hub-1.png
```

### station-hub-7 (EDIT from station-hub-1)

```bash
npx tsx scripts/generate-image.ts "Same space station hub, rotated 270 degrees clockwise from the original, everything else identical" --output star-command/station/station-hub-7.png --reference star-command/station/station-hub-1.png
```

### station-hub-8 (EDIT from station-hub-1)

```bash
npx tsx scripts/generate-image.ts "Same space station hub, rotated 315 degrees clockwise from the original, everything else identical" --output star-command/station/station-hub-8.png --reference star-command/station/station-hub-1.png
```

---

## Summary

| Category        | Count  | Base Images         | Edit Images |
| --------------- | ------ | ------------------- | ----------- |
| Admiral Avatars | 5      | 1                   | 4           |
| Crew Avatars    | 5      | 1                   | 4           |
| CRT Frame       | 7      | 1                   | 6           |
| Status Bar      | 3      | 1                   | 2           |
| Status Chips    | 7      | 1 (frame) + 1 (dot) | 5           |
| Shuttle         | 4      | 1                   | 3           |
| Particles       | 16     | 5                   | 11          |
| Data Orbs       | 3      | 1                   | 2           |
| Beacon          | 2      | 1                   | 1           |
| Station Hub     | 8      | 1                   | 7           |
| **Total**       | **60** | **15**              | **45**      |

**Recommended generation order:** Admiral → Crew → CRT → StatusBar → Chips → Shuttle → Particles → Orbs → Beacon → Checkmark → Station

Start with the admiral-default base image since it sets the overall art style tone for the whole set.
