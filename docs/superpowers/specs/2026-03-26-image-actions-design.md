# Image Actions System Design

Date: 2026-03-26

## Summary

Add an extensible "image actions" system to Fleet that lets users run image transforms (background removal, upscale, etc.) on existing images — whether generated in the gallery or opened via the file viewer. Actions are config-driven, registered per-provider, and produce new generation entries in the existing image generation system.

The first action shipped is **Remove Background** via fal.ai's BRIA RMBG 2.0 model.

## Decisions

- **Config-driven actions** over handler classes — most fal.ai transform models share the same pattern (image in, image out). A shared executor handles the API call; each action is just a config object.
- **Actions registered per-provider** — `FalAiProvider.getActions()` returns its action configs. Multiple providers can offer the same `actionType` (e.g. `remove-background`). The user's default provider is used unless overridden.
- **New generation entry per action result** — fits the existing data model, shows up in the gallery timeline, full meta tracking. The generation's `mode` is `action:<actionType>`.
- **Sync-mode execution** — these transforms are fast. Direct `fetch` call with `sync_mode: true`, no queue/poll needed.
- **Available in 3 surfaces** — ImageDetail (gallery), ImageViewerPane (file viewer), and CLI.

## Action Config Schema

```ts
// src/main/image-providers/action-types.ts

type ImageActionConfig = {
  id: string;              // unique per provider: 'fal-ai:remove-background'
  actionType: string;      // shared across providers: 'remove-background'
  provider: string;        // 'fal-ai'
  name: string;            // 'Remove Background'
  description: string;
  endpoint: string;        // 'https://fal.run/fal-ai/bria/background/remove'
  inputMapping: (imageUrl: string) => Record<string, unknown>;
  outputMapping: (response: unknown) => { url: string; width: number; height: number };
  outputFormat: string;    // 'png'
};
```

Built-in remove-background config:

```ts
{
  id: 'fal-ai:remove-background',
  actionType: 'remove-background',
  provider: 'fal-ai',
  name: 'Remove Background',
  description: 'Remove the background from an image (BRIA RMBG 2.0)',
  endpoint: 'https://fal.run/fal-ai/bria/background/remove',
  inputMapping: (url) => ({ image_url: url, sync_mode: true }),
  outputMapping: (res) => ({
    url: res.image.url,
    width: res.image.width,
    height: res.image.height
  }),
  outputFormat: 'png',
}
```

## ImageProvider Interface Changes

```ts
interface ImageProvider {
  // ...existing methods (submit, poll, getResult, cancel, configure)...
  getActions(): ImageActionConfig[];
}
```

## ImageService.runAction Flow

New method: `runAction(actionType: string, source: string, provider?: string)`

1. Look up action config by `actionType` (+ optional provider override, else default provider)
2. Resolve source image:
   - Local file path → read and convert to data URI
   - URL → pass through
   - `<generationId>/<filename>` → resolve from `~/.fleet/images/generations/` dir
3. Create new generation entry with `mode: 'action:<actionType>'`
4. Call endpoint via `fetch` (sync mode)
5. Run `outputMapping` on response, download result image
6. Save to generation dir, update meta to `completed`
7. Emit `changed`

New method: `listActions(provider?: string): ImageActionConfig[]`

Returns available actions for the given provider (or all providers).

## Type Changes

```ts
// src/shared/types.ts

// Before:
export type ImageGenerationMode = 'generate' | 'edit';

// After:
export type ImageGenerationMode = 'generate' | 'edit' | `action:${string}`;

// Add to ImageGenerationMeta:
export type ImageGenerationMeta = {
  // ...existing fields...
  sourceImage: string | null;  // path, URL, or generationId/filename reference
};
```

## UI Surfaces

### ImageDetail (Gallery)

Add an "Actions" section below existing Retry/Copy Path/Delete buttons. For each completed image, show available action buttons. Clicking one calls `imageStore.runAction(actionType, generationId, filename)`. Shows loading state while running.

### ImageViewerPane (File Viewer)

Add action buttons to the status bar, separated from zoom controls. Source is the current `filePath`. Same action list.

Both surfaces create a new generation entry — result appears in the gallery automatically.

## IPC

New channels:
- `images:runAction` — args: `{ actionType, source, provider? }` → returns `{ id: string }`
- `images:listActions` — args: `{ provider? }` → returns serializable action info (id, actionType, provider, name, description) — the `inputMapping`/`outputMapping` functions stay server-side only

## CLI

Command: `fleet images action <action-type> <source> [--provider <id>]`

Examples:
```
fleet images action remove-background ./photo.png
fleet images action remove-background ./photo.png --provider fal-ai
fleet images action remove-background <generation-id>/image-001.png
```

Wiring:
- `fleet-cli.ts`: map `images.action` → `image.action`, validate action type and source
- `socket-server.ts`: handle `image.action`, call `imageService.runAction()`
- Add `image.actions.list` command for listing available actions

## Files to Create

- `src/main/image-providers/action-types.ts` — `ImageActionConfig` type + shared output mapping validator

## Files to Modify

- `src/main/image-providers/types.ts` — add `getActions()` to `ImageProvider` interface
- `src/main/image-providers/fal-ai.ts` — implement `getActions()` returning remove-background config
- `src/shared/types.ts` — extend `ImageGenerationMode`, add `sourceImage` to `ImageGenerationMeta`
- `src/main/image-service.ts` — add `runAction()`, `listActions()`, `resolveSourceImage()`
- `src/main/socket-server.ts` — handle `image.action` and `image.actions.list`
- `src/main/fleet-cli.ts` — add `images.action` command mapping + validation
- `src/main/ipc-handlers.ts` — add `images:runAction` and `images:listActions` handlers
- `src/preload/index.ts` — expose `runAction` and `listActions`
- `src/renderer/src/store/image-store.ts` — add `runAction` and `actions` state
- `src/renderer/src/components/ImageGallery/ImageDetail.tsx` — add action buttons
- `src/renderer/src/components/ImageViewerPane.tsx` — add action buttons to status bar
