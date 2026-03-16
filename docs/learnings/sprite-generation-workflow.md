# Sprite Generation Workflow

## Overview

AI-generated sprites flow through three stages before landing in the sprite sheet:

```
sprites-staging/  →  sprites-raw/  →  sprites.png
  (generated)        (bg removed)     (assembled)
```

## Step 1: Generate

```bash
npx tsx scripts/generate-image.ts "<prompt>" --output <subdir/name.png>
```

- Saves to `sprites-staging/<subdir>/<name>.png`
- Uses fal.ai Nano Banana 2 (Gemini 2.0 Flash image generation)
- Defaults: `0.5K` resolution, `1:1` aspect ratio, `png` output — ideal for sprites
- `--output` is required and must match the target filename in `sprites-raw/`

Example — base idle frame (no reference):
```bash
npx tsx scripts/generate-image.ts "Pixel art sprite, top-down spaceship..." \
  --output ships/parent-1-arrow-idle-1.png
```

Example — animation frame using idle as reference for consistency:
```bash
npx tsx scripts/generate-image.ts "Keep the exact same ship design. Engine nozzles blazing bright..." \
  --output ships/parent-1-arrow-thrust-1.png \
  --reference ships/parent-1-arrow-idle-1.png
```

The `--reference` flag passes the idle frame as a base64 data URI in the `images` array, so the model edits from the actual image rather than generating from scratch. This keeps ship design, colors, and shape consistent across all animation frames.

## Step 2: Remove Background

```bash
npx tsx scripts/remove-background.ts
```

- Reads all images from `sprites-staging/`
- Sends each as a base64 data URI to fal.ai Bria RMBG 2.0
- Saves result to `sprites-raw/<subdir>/<name>.png` (same filename, no suffix)
- Skips files already present in `sprites-raw/`

## Step 3: Assemble

```bash
npx tsx scripts/assemble-sprites.ts
```

Validates all 125 expected files exist in `sprites-raw/`, resizes to exact pixel dimensions, and packs into `src/renderer/src/assets/sprites.png`.

## Configuration

`FAL_KEY` is loaded from `.env` automatically — no need to pass it on the command line:

```
FAL_KEY=your_key_here
```

## Lessons Learned

- **Use `import.meta.url` not `import.meta.dirname`** — tsx runs scripts as CJS, so `import.meta.dirname` is undefined. Use `dirname(fileURLToPath(import.meta.url))` instead (per CLAUDE.md).
- **Upload endpoint doesn't exist** — `https://fal.run/files/upload` returns 404. Pass images as base64 data URIs directly in the `image_url` field instead. Bria RMBG accepts `data:<mime>;base64,<data>`.
- **`sprites-staging/` decouples generation from bg removal** — lets you regenerate individual sprites without re-running bg removal on everything, and vice versa.
