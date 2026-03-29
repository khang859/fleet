# PixelLab Character Generation

## Overview

PixelLab MCP tools can generate pixel art characters with directional views and template-based animations. Used to create the copilot mascot sprite sheet.

## Key Findings

- **Quadruped `proportions` are ignored.** The `proportions` parameter (chibi, cartoon, etc.) only works for humanoid body types. For quadrupeds, describe the style in the text prompt instead (e.g., "cute chibi-proportioned").
- **Minimum directions is 4.** Even if you only need one direction (south/front-facing), the API generates 4 or 8. Just use the south frames and discard the rest.
- **Color descriptions matter a lot.** "Purple and magenta nebula-patterned" on a dog template produced a sickly-looking result. Concrete, grounded color descriptions work better (e.g., "teal skin with dark gold accents").
- **Template choice shapes the result more than the prompt.** Even with high `ai_freedom` (900), a `dog` template still looks like a dog. If you want something alien, pick the closest body shape (e.g., `cat` for a small crouching creature) and describe the desired features.
- **Available animations vary by template.** Dog has 10 animations, cat has 19. Call `get_character` after creation to see available `template_animation_id` values.
- **Template animations cost 1 generation/direction. Custom animations cost 20-40.** Always try template animations first. Custom animations require explicit cost confirmation (`confirm_cost: true`) on second call.
- **Animation queuing can silently fail.** When queuing multiple animations in parallel, some may not register. Check `get_character` after and re-queue any missing ones.
- **Jobs take 2-5 minutes.** Character creation ~2-3 min, animations ~2-4 min each. All operations are non-blocking — use `get_character` to poll status.

## Sprite Sheet Assembly

PixelLab ZIP structure:
```
rotations/south.png, east.png, north.png, west.png
animations/<name>/south/frame_000.png, frame_001.png, ...
metadata.json
```

To assemble into a horizontal sprite strip for the copilot (which expects 128x128px frames):
1. Pick specific frame indices from each animation (animations often have more frames than needed)
2. Use Pillow to paste frames into a single RGBA image
3. Generate base64 data URI for the `.ts` asset file: `export default 'data:image/png;base64,...';`

## Useful Parameters

- `ai_freedom: 800-900` — higher values let the AI deviate more from the template skeleton. Good for alien/fantasy creatures.
- `detail: "high detail"` — worth using at 128px canvas size.
- `shading: "medium shading"` — good balance for small sprites.
- `outline: "single color outline"` — reads well at small sizes, less harsh than black outline.
