# Mascot Sprite Optimization Design

## Problem

The copilot mascot system stores 5 sprite sheets as base64-encoded data URIs in `.ts` files, totaling ~1 MB. This causes:

1. **Bundle bloat** — all 5 mascots are inlined into the JS bundle regardless of which one the user selects
2. **Git repo bloat** — 65K-character single-line base64 strings produce noisy, unreadable diffs
3. **Poor DX** — adding a mascot requires a base64 conversion step, a new `.ts` file, an import in `sprite-loader.ts`, and a registry entry

The system needs to scale to 30+ mascots while remaining fully offline-capable.

## Solution

Replace base64 `.ts` files with static `.webp` files served via a custom Electron protocol.

## File Storage

Sprite sheets live as plain `.webp` files shipped alongside the app:

```
resources/
  mascots/
    officer.webp
    robot.webp
    cat.webp
    bear.webp
    kraken.webp
```

- Each file is a 9-frame horizontal sprite strip (1152x128px), same layout as today: `idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)`
- WebP lossless compression is ~30-50% smaller than PNG, and eliminates the ~33% overhead of base64 encoding
- `electron-builder` ships this folder via `extraResources`

## Electron Protocol Handler

A custom protocol registered in the main process serves mascot assets to the renderer:

```
fleet-asset://mascots/robot.webp  ->  <app-resources>/mascots/robot.webp
```

- Registered via `protocol.handle('fleet-asset', ...)` at app startup
- Resolves file path using `process.resourcesPath` (production) or the repo `resources/` directory (development)
- Returns the file buffer with the appropriate MIME type
- Scoped to the `resources/` directory to prevent path traversal

## Sprite Loader Changes

`sprite-loader.ts` simplifies from a registry of base64 imports to a single URL constructor:

```ts
export function getSpriteSheet(id: string): string {
  return `fleet-asset://mascots/${id}.webp`
}
```

No imports, no registry object. Falls back to `officer` if the ID is not in `MASCOT_REGISTRY`.

## Renderer Changes

**`SpaceshipSprite.tsx`** — no changes. Already uses the return value of `getSpriteSheet()` as a CSS `background-image` URL.

**`MascotPicker.tsx`** — no changes. Thumbnails already render via `getSpriteSheet()`.

## Assembly Script Changes

`assemble-copilot-sprites.ts` is updated to:

- Output `resources/mascots/<id>.webp` instead of a base64 `.ts` file
- Use sharp's `.webp({ lossless: true })` for pixel-perfect output
- No longer generate `.ts` or `.png` intermediate files

## Adding a New Mascot (Updated DX)

1. Generate 9 frames
2. Run: `npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> path/to/frames/`
   - Outputs `resources/mascots/<mascot-id>.webp`
3. Add entry to `MASCOT_REGISTRY` in `src/shared/mascots.ts`

No sprite-loader changes, no imports, no base64 step.

## Migration & Cleanup

**Deleted:**
- All `sprites-*.ts` files in `src/renderer/copilot/src/assets/`
- `copilot-sprites.ts` and `copilot-sprites.png`

**Created:**
- `resources/mascots/` with 5 `.webp` files converted from existing sprites

**Modified:**
- `assemble-copilot-sprites.ts` — output WebP to `resources/mascots/`
- `sprite-loader.ts` — URL construction instead of base64 imports
- `electron-builder` config — add `resources/mascots` to `extraResources`
- Main process — register `fleet-asset` protocol handler
- `CLAUDE.md` — update mascot workflow docs

**Existing sprite migration:** Decode the current base64 data back to image data, then convert to WebP via sharp. If original source frames are available, re-run the updated assembly script instead.

## No User-Facing Changes

The mascot picker, animation, selection persistence, and offline capability all work exactly as before.
